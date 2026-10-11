import { createServer } from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import postgres from "postgres";
import worker from "../worker.ts";

// Runs the real edge/worker.ts under Node (--experimental-strip-types) against a live Postgres
// loaded with db/schema.sql, plus mock n8n primary/secondary, n8n events, and VAPI controlUrl.
// Self-seeding: creates its own tenant + number (max_concurrent_calls=2); ids are unique per run.
const DB_URL = process.env.EDGE_TEST_DB ?? "postgres://voice_app@127.0.0.1:55432/t1";
const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const PH = `ph_edge_${RUN}`;
{
  const sql = postgres(DB_URL, { max: 1 });
  await sql`INSERT INTO voice.tenants (id, client_key, name, jurisdiction, status, failover_number, vapi_squad_id)
            VALUES (${TENANT}, ${"edge_test_" + RUN}, 'Edge Test', 'US', 'active', '+18005550100', 'squad_edge')`;
  await sql.begin(async (tx) => {
    await tx`SELECT voice.set_tenant(${TENANT})`;
    await tx`INSERT INTO voice.phone_numbers (tenant_id, e164, vapi_phone_id, max_concurrent_calls)
             VALUES (${TENANT}, ${"+1202" + String(Date.now()).slice(-7)}, ${PH}, 2)`;
  });
  await sql.end();
}
const kv = new Map();
const KV = { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) };
kv.set(`tenant:profile:${TENANT}`, JSON.stringify({ name: "Edge Test", busyMessage: "busy-msg" }));

// Mock backends: behaviour switchable per test
const hits = { primary: 0, secondary: 0, events: 0, control: [] };
let primaryDelay = 0, secondaryDelay = 0, secondaryUp = true, verifyAnswer = "VERIFIED";
const SIGNKEY = "edge-key";
function srv(handler) { const s = createServer(handler); return new Promise((r) => s.listen(0, () => r(s))); }
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const checkSig = (req, body) => crypto.createHmac("sha256", SIGNKEY).update(`${req.headers["x-edge-timestamp"]}.${body}`).digest("hex") === req.headers["x-edge-signature"];
const answer = (res, body) => { const p = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result: p.tool === "verify_identity" ? verifyAnswer : "slot ok" })); };
const primary = await srv(async (req, res) => { const b = await readBody(req); hits.primary++; assert.ok(checkSig(req, b)); setTimeout(() => answer(res, b), primaryDelay); });
const secondary = await srv(async (req, res) => { const b = await readBody(req); hits.secondary++; if (!secondaryUp) { res.statusCode = 503; return res.end(); } setTimeout(() => answer(res, b), secondaryDelay); });
const events = await srv(async (req, res) => { const b = await readBody(req); hits.events++; hits.eventsSigOk = checkSig(req, b); res.end("{}"); });
const control = await srv(async (req, res) => { hits.control.push(JSON.parse(await readBody(req))); res.end("{}"); });
const u = (s, p = "") => `http://127.0.0.1:${s.address().port}${p}`;

const env = (dbPort = 0) => ({
  HYPERDRIVE: { connectionString: dbPort === 1 ? "postgres://voice_app@127.0.0.1:1/t1" : DB_URL }, TENANT_KV: KV,
  VAPI_WEBHOOK_SECRET: "vapi-secret", EDGE_N8N_SIGNING_KEY: SIGNKEY,
  N8N_EVENTS_URL: u(events), N8N_TOOLS_URL: u(primary), N8N_TOOLS_URL_SECONDARY: u(secondary),
});
async function call(message, { secret = "vapi-secret", path = "/webhook/vapi-tool-call", e = env() } = {}) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const res = await worker.fetch(new Request(`https://edge${path}`, { method: "POST", headers: { "x-vapi-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ message }) }), e, ctx);
  await Promise.allSettled(pending);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const vcall = (id0, extra = {}) => { const id = `${id0}_${RUN}`; return { id, type: "inboundPhoneCall", phoneNumberId: PH, customer: { number: "+13055550123" }, monitor: { controlUrl: u(control, `/control/${id}`) }, ...extra }; };
const tool = (id, name, args = {}) => ({ id: `${id}_${RUN}`, type: "function", function: { name, arguments: args } });
const R = (name, ok) => console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
let fails = 0; const check = (name, fn) => { try { fn(); R(name, true); } catch (e) { fails++; R(name, false); console.log("      ", e.message.split("\n").slice(0, 6).join(" | ")); } };

let r;
r = await call({ type: "assistant-request", call: vcall("c1") }, { secret: "wrong" });
check("bad X-Vapi-Secret → 401", () => assert.equal(r.status, 401));

const a1 = await call({ type: "assistant-request", call: vcall("c1") });
const a2 = await call({ type: "assistant-request", call: vcall("c2") });
const a3 = await call({ type: "assistant-request", call: vcall("c3") });
check("calls 1-2 get the squad", () => { assert.deepEqual(a1.body, { squadId: "squad_edge" }); assert.deepEqual(a2.body, { squadId: "squad_edge" }); });
check("call 3 over max_concurrent=2 → failover destination", () => assert.deepEqual(a3.body, { destination: { type: "number", number: "+18005550100", message: "busy-msg" } }));
r = await call({ type: "assistant-request", call: vcall("c1") });
check("assistant-request resend for c1 is idempotent", () => assert.deepEqual(r.body, { squadId: "squad_edge" }));

r = await call({ type: "status-update", status: "ended", call: vcall("c1") });
const a4 = await call({ type: "assistant-request", call: vcall("c4") });
check("status-update(ended) releases slot → next call admitted", () => { assert.equal(r.status, 200); assert.deepEqual(a4.body, { squadId: "squad_edge" }); });
check("async event forwarded to n8n with valid HMAC", () => { assert.equal(hits.events, 1); assert.equal(hits.eventsSigOk, true); });

r = await call({ type: "tool-calls", call: vcall("c2"), toolCallList: [tool("t1", "check_availability", { service: "x" })] });
check("PHI tool before verify_identity is gated (no backend call)", () => { assert.match(r.body.results[0].result, /verify your identity/); assert.equal(hits.primary + hits.secondary, 0); });

primaryDelay = 3000; secondaryDelay = 100;
let t0 = Date.now();
r = await call({ type: "tool-calls", call: vcall("c2"), toolCallList: [tool("t2", "verify_identity", { last_name: "Doe" })] });
let ms = Date.now() - t0;
check(`slow primary → secondary answers within budget (${ms} ms)`, () => { assert.equal(r.body.results[0].result, "Thanks, you're verified."); assert.ok(ms < 2500, `${ms}ms`); assert.ok(ms >= 1500, "primary should get its 1500ms share"); assert.equal(hits.secondary, 1); });

primaryDelay = 0;
r = await call({ type: "tool-calls", call: vcall("c2"), toolCallList: [tool("t3", "check_availability", { service: "x" })] });
check("after verify, PHI tool reaches backend", () => assert.equal(r.body.results[0].result, "slot ok"));

const before = hits.primary + hits.secondary;
r = await call({ type: "tool-calls", call: vcall("c2"), toolCallList: [tool("t3", "check_availability", { service: "x" })] });
check("duplicate toolCallId → stored response, backend not re-called", () => { assert.equal(r.body.results[0].result, "slot ok"); assert.equal(hits.primary + hits.secondary, before); });

primaryDelay = 5000; secondaryUp = false;
t0 = Date.now();
r = await call({ type: "tool-calls", call: vcall("c4"), toolCallList: [tool("t4", "verify_identity", { last_name: "Doe" })] });
ms = Date.now() - t0;
check(`both backends down → transfer message (${ms} ms tool latency incl. 1.5s transfer delay in waitUntil)`, () => {
  assert.match(r.body.results[0].result, /transferring you/);
  assert.deepEqual(hits.control.at(-1), { type: "transfer", destination: { type: "number", number: "+18005550100" } });
});

primaryDelay = 5000; secondaryUp = true; secondaryDelay = 5000;
t0 = Date.now();
const pending = [];
const ctx2 = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
const res2 = await worker.fetch(new Request("https://edge/webhook/vapi-tool-call", { method: "POST", headers: { "x-vapi-secret": "vapi-secret" },
  body: JSON.stringify({ message: { type: "tool-calls", call: vcall("c4"), toolCallList: [tool("t6", "log_callback_request", { topic: "billing" })] } }) }), env(), ctx2);
ms = Date.now() - t0;
const b2 = await res2.json();
await Promise.allSettled(pending);
check(`both backends hang → response at the 2500 ms budget (${ms} ms), under VAPI's 3 s timeout`, () => {
  assert.match(b2.results[0].result, /transferring you/); assert.ok(ms >= 2400 && ms < 2900, `${ms}ms`);
});
primaryDelay = 0; secondaryDelay = 0;

r = await call({ type: "tool-calls", call: vcall("c2"), toolCallList: [tool("t5", "request_opt_out")] });
check("request_opt_out confirms", () => assert.match(r.body.results[0].result, /removed from our call list/));

r = await call({ type: "end-of-call-report", call: vcall("c2") }, { path: "/vapi/events" });
check("end-of-call-report on alias path releases + acks", () => assert.deepEqual(r.body, { ok: true }));

r = await call({ type: "assistant-request", call: vcall("c9") }, { e: env(1) });
check("DB down → last-known-good failover destination", () => assert.deepEqual(r.body?.destination?.number, "+18005550100"));

kv.clear();
r = await call({ type: "assistant-request", call: { ...vcall("c10"), phoneNumberId: "ph_unknown" } });
check("unknown number → 403, never another tenant's assistant", () => assert.equal(r.status, 403));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
for (const s of [primary, secondary, events, control]) s.close();
process.exit(fails ? 1 : 0);
