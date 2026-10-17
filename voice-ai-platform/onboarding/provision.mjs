#!/usr/bin/env node
// Client onboarding: validate client_config.json, then (with --apply) provision
// Postgres tenant rows, VAPI assistants/squad, phone-number routing, and the edge KV profile.
//
//   node provision.mjs examples/acme.client_config.json            # dry run: validate + print plan
//   node provision.mjs examples/acme.client_config.json --apply    # provision
//
// Env (apply only): DATABASE_URL, VAPI_API_KEY, VAPI_WEBHOOK_SECRET, EDGE_BASE_URL,
//                   CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID
// Optional:         VAPI_BASE_URL (default https://api.vapi.ai), CF_API_BASE
//
// Idempotent: re-running PATCHes the VAPI resources whose ids are stored on the tenant row.
import { readFileSync } from "node:fs";
import pg from "pg";
import { validate, buildAssistants, buildSquad, phoneBinding, kvProfile, normJurisdiction } from "./lib/build.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const file = args.find((a) => !a.startsWith("--"));
if (!file) die("usage: provision.mjs <client_config.json> [--apply]");

const cfg = JSON.parse(readFileSync(file, "utf8"));
const { errors, warnings } = validate(cfg, { apply });
warnings.forEach((w) => console.error(`warn: ${w}`));
if (errors.length) {
  errors.forEach((e) => console.error(`error: ${e}`));
  process.exit(2);
}

const env = {
  edgeBaseUrl: process.env.EDGE_BASE_URL ?? cfg.vapi_assistant.server_url ?? "https://voice-edge.example.com",
  webhookSecret: process.env.VAPI_WEBHOOK_SECRET ?? "<VAPI_WEBHOOK_SECRET>",
};
const assistants = buildAssistants(cfg, env);

if (!apply) {
  const redact = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "secret" ? "***" : v)));
  console.log(JSON.stringify({
    mode: "dry-run",
    tenant: { client_key: cfg.client_id, jurisdiction: normJurisdiction(cfg.compliance.jurisdiction), hipaa: cfg.compliance.hipaa_mode },
    assistants: assistants.map((a) => ({ key: a.key, spec: redact(a.spec) })),
    squad: buildSquad(cfg, Object.fromEntries(assistants.map((a) => [a.key, `<${a.spec.name}>`]))),
    phone_numbers: cfg.telephony.phone_numbers.map((p) => ({ number: p.number, max_concurrent_calls: p.max_concurrent_calls, binding: redact(phoneBinding(env)) })),
    kv_profile: kvProfile(cfg),
  }, null, 2));
  process.exit(0);
}

for (const k of ["DATABASE_URL", "VAPI_API_KEY", "VAPI_WEBHOOK_SECRET", "EDGE_BASE_URL", "CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_KV_NAMESPACE_ID"]) {
  if (!process.env[k]) die(`missing env ${k}`);
}
const VAPI = (process.env.VAPI_BASE_URL ?? "https://api.vapi.ai").replace(/\/$/, "");
const CF = (process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await run();
} catch (e) {
  console.error(`failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

async function run() {
  const c = cfg.compliance;
  // 1. Tenant row, pending until everything else succeeds.
  const { rows: [tenant] } = await db.query(
    `INSERT INTO voice.tenants (client_key, name, jurisdiction, hipaa, baa_verified_at, pia_completed_at,
                                retention_days, recording_enabled, failover_number, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
     ON CONFLICT (client_key) DO UPDATE SET
       name = EXCLUDED.name, jurisdiction = EXCLUDED.jurisdiction, hipaa = EXCLUDED.hipaa,
       baa_verified_at = EXCLUDED.baa_verified_at, pia_completed_at = EXCLUDED.pia_completed_at,
       retention_days = EXCLUDED.retention_days, recording_enabled = EXCLUDED.recording_enabled,
       failover_number = EXCLUDED.failover_number
     RETURNING id, vapi_assistant_ids, vapi_squad_id, status`,
    [cfg.client_id, cfg.client_name, normJurisdiction(c.jurisdiction), c.hipaa_mode, c.baa_verified_at ?? null,
     c.pia_completed_at ?? null, c.data_retention_days, c.recording_enabled && !c.hipaa_mode, cfg.telephony.failover_routing_number],
  );
  log("tenant", tenant.id, tenant.status);

  // 2a. Refuse numbers owned by another tenant BEFORE touching VAPI.
  for (const p of cfg.telephony.phone_numbers) {
    const { rows: [o] } = await db.query("SELECT voice.phone_number_owner($1) AS owner", [p.number]);
    if (o.owner && o.owner !== tenant.id) throw new Error(`${p.number} already belongs to another tenant; refusing to re-route it`);
  }

  // 2b. Phone numbers must already be imported into VAPI (carrier credentials stay out of this tool).
  const vapiNumbers = await vapi("GET", "/phone-number");
  const byNumber = new Map(vapiNumbers.map((p) => [p.number, p]));
  const missing = cfg.telephony.phone_numbers.filter((p) => !byNumber.has(p.number));
  if (missing.length) {
    throw new Error(`not imported into VAPI yet: ${missing.map((m) => `${m.number} (${m.provider})`).join(", ")}. ` +
      "Import them in the VAPI dashboard or POST /phone-number with carrier credentials, then re-run.");
  }

  // 3. Assistants. Persist each new id immediately so a mid-run failure never orphans resources.
  const ids = { ...tenant.vapi_assistant_ids };
  for (const a of assistants) {
    if (ids[a.key]) {
      await vapi("PATCH", `/assistant/${ids[a.key]}`, a.spec);
      log("assistant updated", a.key, ids[a.key]);
    } else {
      const created = await vapi("POST", "/assistant", a.spec);
      ids[a.key] = created.id;
      await db.query(`UPDATE voice.tenants SET vapi_assistant_ids = vapi_assistant_ids || $2::jsonb WHERE id = $1`,
        [tenant.id, JSON.stringify({ [a.key]: created.id })]);
      log("assistant created", a.key, created.id);
    }
  }

  // 4. Squad (multi-language without auto-detect) or single assistant.
  const squadSpec = buildSquad(cfg, ids);
  let squadId = tenant.vapi_squad_id;
  if (squadSpec) {
    if (squadId) await vapi("PATCH", `/squad/${squadId}`, squadSpec);
    else squadId = (await vapi("POST", "/squad", squadSpec)).id;
    log("squad", squadId);
  } else {
    squadId = null;
  }
  const singleId = squadSpec ? null : ids[assistants[0].key];
  await db.query(`UPDATE voice.tenants SET vapi_squad_id = $2, vapi_assistant_id = $3 WHERE id = $1`, [tenant.id, squadId, singleId]);

  // 5. Route numbers to the edge (assistant-request) and register them for the concurrency gate.
  for (const p of cfg.telephony.phone_numbers) {
    const vp = byNumber.get(p.number);
    await vapi("PATCH", `/phone-number/${vp.id}`, phoneBinding(env));
    await db.query("BEGIN");
    await db.query("SELECT voice.set_tenant($1)", [tenant.id]);
    await db.query(
      `INSERT INTO voice.phone_numbers (tenant_id, e164, vapi_phone_id, provider, line_type, max_concurrent_calls)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (e164) DO UPDATE SET vapi_phone_id = EXCLUDED.vapi_phone_id, provider = EXCLUDED.provider,
         line_type = EXCLUDED.line_type, max_concurrent_calls = EXCLUDED.max_concurrent_calls
       WHERE voice.phone_numbers.tenant_id = EXCLUDED.tenant_id
       RETURNING id`,
      [tenant.id, p.number, vp.id, p.provider, p.line_type ?? null, p.max_concurrent_calls],
    ).then(async (r) => {
      if (r.rowCount !== 1) { await db.query("ROLLBACK"); throw new Error(`${p.number}: ownership changed during provisioning`); }
    });
    await db.query("COMMIT");
    log("phone", p.number, vp.id, `max=${p.max_concurrent_calls}`);
  }

  // 6. Edge KV profile (non-sensitive display config) and cache bust.
  await cf("PUT", `/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}/values/tenant:profile:${tenant.id}`, kvProfile(cfg));
  for (const p of cfg.telephony.phone_numbers) {
    await cf("DELETE", `/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}/values/tenant:phone:${byNumber.get(p.number).id}`);
  }
  log("kv profile written");

  // 7. Activate. DB CHECK constraints refuse HIPAA without BAA / Quebec without PIA.
  await db.query(`UPDATE voice.tenants SET status = 'active' WHERE id = $1`, [tenant.id]);
  log("active", cfg.client_id);
}

async function vapi(method, path, body) {
  return http(`${VAPI}${path}`, method, body, { authorization: `Bearer ${process.env.VAPI_API_KEY}` });
}

async function cf(method, path, body) {
  return http(`${CF}/accounts/${process.env.CF_ACCOUNT_ID}${path}`, method, body, { authorization: `Bearer ${process.env.CF_API_TOKEN}` }, { okStatuses: [404] });
}

async function http(url, method, body, headers, { okStatuses = [] } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (res.ok || okStatuses.includes(res.status)) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 3) {
      throw new Error(`${method} ${new URL(url).pathname} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt) * Math.random()));
  }
}

function log(...a) {
  console.log(`[provision] ${a.join(" ")}`);
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}
