/**
 * Voice edge gateway — Cloudflare Worker.
 *
 * Responsibilities (everything on the synchronous voice path):
 *   - Authenticate VAPI server messages (X-Vapi-Secret, constant-time).
 *   - Resolve tenant from the dialed number / server-set call metadata — never from tool args.
 *   - Answer `assistant-request` and `transfer-destination-request` from cached tenant config.
 *   - Execute tool calls with idempotency, PHI gating and a hard deadline.
 *   - Forward async events (end-of-call-report, status-update, hang) to n8n, HMAC-signed,
 *     after acknowledging VAPI.
 *
 * Bindings (wrangler.toml): HYPERDRIVE (Postgres), TENANT_KV (KV), secrets VAPI_WEBHOOK_SECRET,
 * EDGE_N8N_SIGNING_KEY, N8N_EVENTS_URL, N8N_TOOLS_URL.
 *
 * Logging rule: log request ids, tool names, durations, status. NEVER arguments or results.
 */
import postgres from "postgres";

export interface Env {
  HYPERDRIVE: { connectionString: string };
  TENANT_KV: KVNamespace;
  VAPI_WEBHOOK_SECRET: string;
  EDGE_N8N_SIGNING_KEY: string;
  N8N_EVENTS_URL: string;
  N8N_TOOLS_URL: string;
}

type Tenant = {
  id: string;
  name: string;
  hipaa: boolean;
  jurisdiction: string;
  timezone: string;
  language: string;
  voiceId: string;
  recordingEnabled: boolean;
  transferNumber: string;
  assistantId?: string | null;
};

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: Record<string, unknown> | string } };
type ToolResult = { toolCallId: string; result?: string; error?: string };

const MAX_BODY = 1_000_000;
const TOOL_DEADLINE_MS = 3_500; // below the shortest tool timeoutSeconds in vapi/tools.json
const PHI_TOOLS = new Set(["check_availability", "book_appointment"]);
const N8N_TOOLS = new Set(["verify_identity", "check_availability", "book_appointment", "log_callback_request"]);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

    if (req.method !== "POST" || !["/vapi/events", "/vapi/tools"].includes(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
      return new Response("payload too large", { status: 413 });
    }
    if (!timingSafeEqual(req.headers.get("x-vapi-secret") ?? "", env.VAPI_WEBHOOK_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY) return new Response("payload too large", { status: 413 });

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const msg = body?.message;
    if (!msg?.type) return new Response("missing message.type", { status: 400 });

    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare: true });
    const t0 = Date.now();
    try {
      const tenant = await resolveTenant(msg, env, sql);
      if (!tenant) {
        log(requestId, msg.type, "tenant_unresolved", t0);
        // For assistant-request, an error makes VAPI end the call; better than routing to the wrong tenant.
        return json({ error: "tenant not resolved" }, 403);
      }

      switch (msg.type) {
        case "assistant-request":
          return json(tenant.assistantId ? { assistantId: tenant.assistantId } : { assistant: buildAssistant(tenant) });

        case "tool-calls": {
          const calls: ToolCall[] = msg.toolCallList ?? [];
          const results = await Promise.all(calls.map((tc) => runTool(tc, msg, tenant, env, sql, requestId)));
          log(requestId, "tool-calls", calls.map((c) => c.function.name).join(","), t0);
          return json({ results });
        }

        case "transfer-destination-request":
          return json({
            destination: {
              type: "number",
              number: tenant.transferNumber,
              message: "Connecting you with a team member now.",
            },
          });

        case "end-of-call-report":
        case "status-update":
        case "hang":
          ctx.waitUntil(forwardToN8n(env.N8N_EVENTS_URL, { tenantId: tenant.id, message: msg }, env, requestId));
          return json({ ok: true });

        default:
          return json({ ok: true, ignored: msg.type });
      }
    } finally {
      ctx.waitUntil(sql.end({ timeout: 1 }));
    }
  },
};

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------
async function resolveTenant(msg: any, env: Env, sql: postgres.Sql): Promise<Tenant | null> {
  const call = msg.call ?? {};
  // Inbound and outbound calls both carry the VAPI phone number they use.
  const phoneId: string | undefined = call.phoneNumberId ?? msg.phoneNumber?.id;
  if (!phoneId) return null;

  const cacheKey = `tenant:phone:${phoneId}`;
  const cached = await env.TENANT_KV.get<Tenant>(cacheKey, "json");
  if (cached) return assertMetadataMatches(cached, call);

  const rows = await sql<{ tenant_id: string; hipaa: boolean; jurisdiction: string; vapi_assistant_id: string | null }[]>`
    SELECT * FROM voice.resolve_tenant_by_vapi_phone(${phoneId})`;
  if (rows.length === 0) return null;

  // Display/voice config is non-sensitive and stored in KV by the admin API on tenant update.
  const profile = (await env.TENANT_KV.get<Partial<Tenant>>(`tenant:profile:${rows[0].tenant_id}`, "json")) ?? {};
  const tenant: Tenant = {
    id: rows[0].tenant_id,
    hipaa: rows[0].hipaa,
    jurisdiction: rows[0].jurisdiction,
    assistantId: rows[0].vapi_assistant_id,
    name: profile.name ?? "our office",
    timezone: profile.timezone ?? "America/New_York",
    language: profile.language ?? "en",
    voiceId: profile.voiceId ?? "",
    recordingEnabled: (profile.recordingEnabled ?? false) && !rows[0].hipaa,
    transferNumber: profile.transferNumber ?? "",
  };
  await env.TENANT_KV.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 60 });
  return assertMetadataMatches(tenant, call);
}

/** Outbound calls carry server-set metadata.tenantId; it must agree with the number's owner. */
function assertMetadataMatches(tenant: Tenant, call: any): Tenant | null {
  const metaTenant = call.assistantOverrides?.metadata?.tenantId ?? call.metadata?.tenantId;
  return metaTenant && metaTenant !== tenant.id ? null : tenant;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
async function runTool(tc: ToolCall, msg: any, tenant: Tenant, env: Env, sql: postgres.Sql, requestId: string): Promise<ToolResult> {
  const name = tc.function.name;
  const args = typeof tc.function.arguments === "string" ? safeParse(tc.function.arguments) : tc.function.arguments ?? {};
  const callId: string = msg.call?.id;
  const caller: string | undefined = msg.call?.customer?.number;

  return withTenant(sql, tenant.id, async (tx) => {
    // Idempotency: VAPI's toolCallId is unique per invocation.
    const seen = await tx`
      INSERT INTO voice.idempotency_keys (key, tenant_id) VALUES (${tc.id}, ${tenant.id})
      ON CONFLICT (key) DO NOTHING RETURNING key`;
    if (seen.length === 0) {
      const [prev] = await tx<{ response: ToolResult | null }[]>`SELECT response FROM voice.idempotency_keys WHERE key = ${tc.id}`;
      return prev?.response ?? { toolCallId: tc.id, result: "That request is already being handled." };
    }

    await tx`
      INSERT INTO voice.calls (vapi_call_id, tenant_id, direction, status)
      VALUES (${callId}, ${tenant.id}, ${msg.call?.type === "outboundPhoneCall" ? "outbound" : "inbound"}, 'in-progress')
      ON CONFLICT (vapi_call_id) DO NOTHING`;
    await tx`INSERT INTO voice.call_state (vapi_call_id, tenant_id) VALUES (${callId}, ${tenant.id}) ON CONFLICT DO NOTHING`;
    const [state] = await tx<{ identity_verified: boolean; verify_attempts: number }[]>`
      SELECT identity_verified, verify_attempts FROM voice.call_state WHERE vapi_call_id = ${callId} FOR UPDATE`;

    let result: ToolResult;
    if (name === "request_opt_out") {
      result = await optOut(tx, tenant, callId, caller, tc.id);
    } else if (PHI_TOOLS.has(name) && !state.identity_verified) {
      result = { toolCallId: tc.id, result: "I need to verify your identity before I can help with that." };
    } else if (name === "verify_identity" && state.verify_attempts >= 3) {
      result = { toolCallId: tc.id, result: "I wasn't able to verify you. Let me connect you with a team member." };
    } else if (N8N_TOOLS.has(name)) {
      result = await callN8nTool(env, requestId, { tenantId: tenant.id, callId, caller, tool: name, args, toolCallId: tc.id });
      if (name === "verify_identity") {
        const verified = result.result?.startsWith("VERIFIED") ?? false;
        await tx`
          UPDATE voice.call_state
          SET identity_verified = ${verified}, verify_attempts = verify_attempts + 1, updated_at = now()
          WHERE vapi_call_id = ${callId}`;
        result.result = verified ? "Thanks, you're verified." : "Those details don't match our records.";
      }
    } else {
      result = { toolCallId: tc.id, error: `unknown tool ${name}` };
    }

    await tx`UPDATE voice.idempotency_keys SET response = ${tx.json(result as any)} WHERE key = ${tc.id}`;
    return result;
  });
}

/** TCPA/CRTC revocation: honored synchronously, on the call, before the caller hangs up. */
async function optOut(tx: postgres.TransactionSql, tenant: Tenant, callId: string, caller: string | undefined, toolCallId: string): Promise<ToolResult> {
  if (caller) {
    await tx`
      INSERT INTO voice.dnc_entries (tenant_id, e164, source) VALUES (${tenant.id}, ${caller}, 'internal')
      ON CONFLICT DO NOTHING`;
    const revoked = await tx<{ id: string }[]>`
      UPDATE voice.consents k SET revoked_at = now()
      FROM voice.contacts c
      WHERE k.contact_id = c.id AND c.e164 = ${caller} AND k.channel = 'voice_ai' AND k.revoked_at IS NULL
      RETURNING k.id`;
    for (const r of revoked) {
      await tx`
        INSERT INTO voice.consent_events (tenant_id, consent_id, event, source, vapi_call_id)
        VALUES (${tenant.id}, ${r.id}, 'revoked', 'voice:request_opt_out', ${callId})`;
    }
  }
  return { toolCallId, result: "Done. You've been removed from our call list and won't receive further automated calls." };
}

async function callN8nTool(env: Env, requestId: string, payload: Record<string, unknown>): Promise<ToolResult> {
  const toolCallId = payload.toolCallId as string;
  try {
    const res = await signedPost(env.N8N_TOOLS_URL, payload, env, requestId, AbortSignal.timeout(TOOL_DEADLINE_MS));
    if (!res.ok) throw new Error(`n8n ${res.status}`);
    const out = (await res.json()) as { result?: string };
    return { toolCallId, result: truncate(out.result ?? "Done.", 500) };
  } catch {
    // Speakable fallback inside the deadline — never leave the caller in silence.
    return { toolCallId, result: "I'm having trouble reaching our system right now. I can transfer you to a team member." };
  }
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
function buildAssistant(t: Tenant) {
  // Abbreviated: in production, load vapi/assistant.base.json at build time and substitute placeholders.
  return {
    name: `${t.name} — Voice Agent`,
    firstMessage: `Hi, thanks for calling ${t.name}. I'm an automated AI assistant, and this call may be recorded for quality. How can I help you today?`,
    compliancePlan: { hipaaEnabled: t.hipaa },
    artifactPlan: { recordingEnabled: t.recordingEnabled },
    voice: { provider: "11labs", voiceId: t.voiceId, model: "eleven_flash_v2_5" },
    transcriber: { provider: "deepgram", model: "nova-3", language: t.language },
    metadata: { tenantId: t.id, schemaVersion: "1" },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function withTenant<T>(sql: postgres.Sql, tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`; // transaction-local; safe with pooling
    return fn(tx);
  }) as Promise<T>;
}

async function forwardToN8n(url: string, payload: unknown, env: Env, requestId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await signedPost(url, payload, env, requestId, AbortSignal.timeout(10_000));
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
    } catch {
      /* network error: retry */
    }
    await sleep(Math.min(8_000, 500 * 2 ** attempt) * Math.random()); // full jitter
  }
  console.log(JSON.stringify({ requestId, level: "error", event: "n8n_forward_failed" }));
}

async function signedPost(url: string, payload: unknown, env: Env, requestId: string, signal: AbortSignal): Promise<Response> {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacHex(env.EDGE_N8N_SIGNING_KEY, `${ts}.${body}`);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edge-timestamp": ts, "x-edge-signature": sig, "x-request-id": requestId },
    body,
    signal,
  });
}

async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0 && b.length > 0;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const safeParse = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (requestId: string, type: string, detail: string, t0: number) =>
  console.log(JSON.stringify({ requestId, type, detail, ms: Date.now() - t0 }));
