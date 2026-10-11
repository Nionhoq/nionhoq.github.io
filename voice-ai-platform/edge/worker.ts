/**
 * Voice edge gateway — Cloudflare Worker.
 *
 * Responsibilities (everything on the synchronous voice path):
 *   - Authenticate VAPI server messages (X-Vapi-Secret, constant-time).
 *   - Resolve tenant from the dialed number / server-set call metadata — never from tool args.
 *   - Answer `assistant-request`: per-number concurrency gate, then squad/assistant id —
 *     or a transfer to the tenant's failover line when full or when the DB is down.
 *   - Execute tool calls with idempotency, PHI gating and a 2,500 ms backend budget
 *     (n8n primary → n8n secondary → live SIP transfer to the failover line).
 *   - Release concurrency slots on status-update(ended) / end-of-call-report.
 *   - Forward async events (end-of-call-report, status-update, hang) to n8n, HMAC-signed,
 *     after acknowledging VAPI.
 *
 * Bindings (wrangler.toml): HYPERDRIVE (Postgres), TENANT_KV (KV), secrets VAPI_WEBHOOK_SECRET,
 * EDGE_N8N_SIGNING_KEY, N8N_EVENTS_URL, N8N_TOOLS_URL, N8N_TOOLS_URL_SECONDARY.
 *
 * Routes: POST /webhook/vapi-tool-call (all message types; the URL onboarding binds),
 *         POST /vapi/events and /vapi/tools (aliases).
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
  N8N_TOOLS_URL_SECONDARY?: string;
}

type Tenant = {
  id: string;
  name: string;
  hipaa: boolean;
  jurisdiction: string;
  timezone: string;
  language: string;
  busyMessage: string;
  recordingEnabled: boolean;
  transferNumber: string;
  assistantId: string | null;
  squadId: string | null;
};

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: Record<string, unknown> | string } };
type ToolResult = { toolCallId: string; result?: string; error?: string };

const MAX_BODY = 1_000_000;
const BACKEND_BUDGET_MS = 2_500; // n8n primary + secondary combined; VAPI tool timeout is 3 s
const PRIMARY_SHARE_MS = 1_500; // primary gets this much, secondary gets the rest
const SLOT_LEASE_SECONDS = 900 + 120; // assistant maxDurationSeconds + margin
const ROUTES = new Set(["/webhook/vapi-tool-call", "/vapi/events", "/vapi/tools"]);
const PHI_TOOLS = new Set(["check_availability", "book_appointment"]);
const N8N_TOOLS = new Set(["verify_identity", "check_availability", "book_appointment", "log_callback_request"]);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

    if (req.method !== "POST" || !ROUTES.has(url.pathname)) {
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
      let tenant: Tenant | null;
      try {
        tenant = await resolveTenant(msg, env, sql);
      } catch (e) {
        // DB unreachable. For a ringing call, hand it to humans using the last-known-good copy.
        if (msg.type === "assistant-request") {
          const lkg = await lastKnownGood(msg, env);
          log(requestId, msg.type, lkg ? "db_down_failover" : "db_down_no_lkg", t0);
          if (lkg?.transferNumber) return json(failoverDestination(lkg));
        }
        throw e;
      }
      if (!tenant) {
        log(requestId, msg.type, "tenant_unresolved", t0);
        // For assistant-request, an error makes VAPI end the call; better than routing to the wrong tenant.
        return json({ error: "tenant not resolved" }, 403);
      }

      switch (msg.type) {
        case "assistant-request": {
          const phoneId = msg.call?.phoneNumberId ?? msg.phoneNumber?.id;
          let slot: { granted: boolean; active: number; max_allowed: number } | undefined;
          try {
            [slot] = await sql<{ granted: boolean; active: number; max_allowed: number }[]>`
              SELECT * FROM voice.acquire_call_slot(${phoneId}, ${msg.call?.id}, ${SLOT_LEASE_SECONDS})`;
          } catch {
            // Tenant came from cache but the DB is down: tools won't work either, so go to humans.
            log(requestId, msg.type, "slot_gate_db_error_failover", t0);
            return json(failoverDestination(tenant));
          }
          if (!slot?.granted) {
            log(requestId, msg.type, `at_capacity ${slot?.active}/${slot?.max_allowed}`, t0);
            return json(failoverDestination(tenant));
          }
          if (tenant.squadId) return json({ squadId: tenant.squadId });
          if (tenant.assistantId) return json({ assistantId: tenant.assistantId });
          ctx.waitUntil(releaseSlot(sql, msg.call?.id));
          return json({ error: "tenant has no assistant provisioned" }, 500);
        }

        case "tool-calls": {
          const calls: ToolCall[] = msg.toolCallList ?? [];
          const results = await Promise.all(calls.map((tc) => runTool(tc, msg, tenant!, env, sql, requestId, ctx)));
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
          if (msg.type === "end-of-call-report" || msg.status === "ended") {
            await releaseSlot(sql, msg.call?.id); // before ack: a leaked slot blocks a real caller
          }
        // falls through
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

  const rows = await sql<{
    tenant_id: string; hipaa: boolean; jurisdiction: string; vapi_assistant_id: string | null;
    vapi_squad_id: string | null; failover_number: string | null;
  }[]>`SELECT * FROM voice.resolve_tenant_by_vapi_phone(${phoneId})`;
  if (rows.length === 0) return null;

  // Display/voice config is non-sensitive and stored in KV by the admin API on tenant update.
  const profile = (await env.TENANT_KV.get<Partial<Tenant>>(`tenant:profile:${rows[0].tenant_id}`, "json")) ?? {};
  const tenant: Tenant = {
    id: rows[0].tenant_id,
    hipaa: rows[0].hipaa,
    jurisdiction: rows[0].jurisdiction,
    assistantId: rows[0].vapi_assistant_id,
    squadId: rows[0].vapi_squad_id,
    name: profile.name ?? "our office",
    timezone: profile.timezone ?? "America/New_York",
    language: profile.language ?? "en-US",
    busyMessage: profile.busyMessage ?? "All of our lines are busy. Transferring you to a team member.",
    recordingEnabled: (profile.recordingEnabled ?? false) && !rows[0].hipaa,
    transferNumber: rows[0].failover_number ?? profile.transferNumber ?? "",
  };
  await Promise.all([
    env.TENANT_KV.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 60 }),
    env.TENANT_KV.put(`tenant:lkg:${phoneId}`, JSON.stringify(tenant)), // no TTL: used only when the DB is down
  ]);
  return assertMetadataMatches(tenant, call);
}

async function lastKnownGood(msg: any, env: Env): Promise<Tenant | null> {
  const phoneId = msg.call?.phoneNumberId ?? msg.phoneNumber?.id;
  return phoneId ? env.TENANT_KV.get<Tenant>(`tenant:lkg:${phoneId}`, "json") : null;
}

/** assistant-request answer that skips the AI and transfers straight to the human line. */
function failoverDestination(t: Tenant) {
  return { destination: { type: "number", number: t.transferNumber, message: t.busyMessage } };
}

async function releaseSlot(sql: postgres.Sql, callId: string | undefined): Promise<void> {
  if (callId) await sql`SELECT voice.release_call_slot(${callId})`;
}

/** Outbound calls carry server-set metadata.tenantId; it must agree with the number's owner. */
function assertMetadataMatches(tenant: Tenant, call: any): Tenant | null {
  const metaTenant = call.assistantOverrides?.metadata?.tenantId ?? call.metadata?.tenantId;
  return metaTenant && metaTenant !== tenant.id ? null : tenant;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
async function runTool(tc: ToolCall, msg: any, tenant: Tenant, env: Env, sql: postgres.Sql, requestId: string, ctx: ExecutionContext): Promise<ToolResult> {
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
      const deadline = Date.now() + BACKEND_BUDGET_MS;
      const out = await callN8nTool(env, requestId, deadline, { tenantId: tenant.id, callId, caller, tool: name, args, toolCallId: tc.id });
      if (out === null) {
        // Both backends down: don't leave the caller with an assistant that can't do anything.
        ctx.waitUntil(liveTransfer(msg, tenant, requestId));
        result = { toolCallId: tc.id, result: "I'm having trouble reaching our system, so I'm transferring you to a team member now." };
        await tx`UPDATE voice.idempotency_keys SET response = ${tx.json(result as any)} WHERE key = ${tc.id}`;
        return result;
      }
      result = { toolCallId: tc.id, result: out };
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

/**
 * n8n primary, then secondary, inside one absolute deadline. Returns the speakable result,
 * or null when no backend answered in time (caller is then live-transferred).
 * Retrying on the secondary can repeat a write the primary finished after its timeout. n8n forwards
 * toolCallId as Idempotency-Key; the system of record MUST dedupe on it (book_appointment).
 */
async function callN8nTool(env: Env, requestId: string, deadline: number, payload: Record<string, unknown>): Promise<string | null> {
  const targets = [env.N8N_TOOLS_URL, env.N8N_TOOLS_URL_SECONDARY].filter(Boolean) as string[];
  for (let i = 0; i < targets.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 200) break;
    const budget = i === 0 && targets.length > 1 ? Math.min(PRIMARY_SHARE_MS, remaining) : remaining;
    try {
      const res = await signedPost(targets[i], payload, env, requestId, AbortSignal.timeout(budget));
      if (!res.ok) throw new Error(`n8n ${res.status}`);
      const out = (await res.json()) as { result?: string };
      return truncate(out.result ?? "Done.", 500);
    } catch {
      log(requestId, "tool_backend_failed", `target=${i}`, deadline - BACKEND_BUDGET_MS);
    }
  }
  return null;
}

/**
 * Live call control: transfer the in-progress call to the tenant's failover line.
 * Uses call.monitor.controlUrl (VAPI live call control; verify field names for your API version).
 */
async function liveTransfer(msg: any, tenant: Tenant, requestId: string): Promise<void> {
  const controlUrl: string | undefined = msg.call?.monitor?.controlUrl;
  if (!controlUrl || !tenant.transferNumber) {
    log(requestId, "live_transfer_unavailable", controlUrl ? "no_number" : "no_control_url", Date.now());
    return;
  }
  await new Promise((r) => setTimeout(r, 1_500)); // let the assistant finish the hand-off sentence
  await fetch(controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "transfer", destination: { type: "number", number: tenant.transferNumber } }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => log(requestId, "live_transfer_failed", "", Date.now()));
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
