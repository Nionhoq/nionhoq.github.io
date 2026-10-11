import { createServer } from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import postgres from "postgres";
import worker, { isOpen } from "../worker.ts";

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
// Distinct caller per call id unless overridden, so the per-caller flood cap only fires where tested.
const callerFor = (id0) => "+1305" + String(5550000 + [...id0].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9999, 7));
const vcall = (id0, extra = {}) => { const id = `${id0}_${RUN}`; return { id, type: "inboundPhoneCall", phoneNumberId: PH, customer: { number: callerFor(id0) }, monitor: { controlUrl: u(control, `/control/${id}`) }, ...extra }; };
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

// ---- inbound-specific: business hours, per-caller cap, callback consent -------------------
const TOR = { timezone: "America/Toronto", weekly: { mon: [["08:30", "18:00"]], sat: [["10:00", "14:00"]] }, closed_dates: ["2026-12-25"] };
check("isOpen: Mon 09:00 Toronto open, 18:00 closed (end exclusive)", () => {
  assert.equal(isOpen(TOR, new Date("2026-10-12T13:00:00Z")), true);
  assert.equal(isOpen(TOR, new Date("2026-10-12T22:00:00Z")), false);
});
check("isOpen: DST — Mon 2 Nov 2026 08:45 EST open, 08:15 closed", () => {
  assert.equal(isOpen(TOR, new Date("2026-11-02T13:45:00Z")), true);
  assert.equal(isOpen(TOR, new Date("2026-11-02T13:15:00Z")), false);
});
check("isOpen: holiday and unlisted day closed; bad tz fails open", () => {
  assert.equal(isOpen({ ...TOR, weekly: { fri: [["00:00", "24:00"]] } }, new Date("2026-12-25T15:00:00Z")), false);
  assert.equal(isOpen(TOR, new Date("2026-10-13T15:00:00Z")), false);
  assert.equal(isOpen({ ...TOR, timezone: "Mars/Olympus" }, new Date()), true);
});

// Start from empty lines, fill both (max_concurrent_calls=2), then probe routing in and out of hours.
const prof = (bh, maxPerCaller = 2) => kv.set(`tenant:profile:${TENANT}`, JSON.stringify({ name: "Edge Test", busyMessage: "busy-msg",
  afterHoursMessage: "closed-msg", afterHoursNumber: "+18005550101", businessHours: bh, maxPerCaller }));
for (const id of ["c2", "c4"]) await call({ type: "end-of-call-report", call: vcall(id) });
const fa = await call({ type: "assistant-request", call: vcall("fill_a") });
const fb = await call({ type: "assistant-request", call: vcall("fill_b") });
check("fixture: both lines filled", () => { assert.deepEqual(fa.body, { squadId: "squad_edge" }); assert.deepEqual(fb.body, { squadId: "squad_edge" }); });
const clearCache = () => { for (const k of [...kv.keys()]) if (k.startsWith("tenant:phone:")) kv.delete(k); };
const ALWAYS = { timezone: "UTC", weekly: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["00:00", "24:00"]]])) };
const NEVER = { timezone: "UTC", weekly: {} };
prof(ALWAYS); clearCache();
r = await call({ type: "assistant-request", call: vcall("full_in_hours") });
check("at capacity during hours → daytime line + busy message", () => assert.deepEqual(r.body.destination, { type: "number", number: "+18005550100", message: "busy-msg" }));
prof(NEVER); clearCache();
r = await call({ type: "assistant-request", call: vcall("full_after_hours") });
check("at capacity after hours → after-hours line + closed message", () => assert.deepEqual(r.body.destination, { type: "number", number: "+18005550101", message: "closed-msg" }));
r = await call({ type: "transfer-destination-request", call: vcall("fill_a") });
check("transfer_to_human after hours → after-hours line", () => assert.equal(r.body.destination.number, "+18005550101"));
primaryDelay = 5000; secondaryUp = false;
r = await call({ type: "tool-calls", call: vcall("fill_b"), toolCallList: [tool("t7", "log_callback_request", { topic: "x" })] });
check("backend outage after hours → live transfer to after-hours line", () => assert.equal(hits.control.at(-1).destination.number, "+18005550101"));
primaryDelay = 0; secondaryUp = true;

// Flood guard: per-caller cap (1) below number capacity (2), lines empty.
for (const id of ["fill_a", "fill_b"]) await call({ type: "end-of-call-report", call: vcall(id) });
prof(ALWAYS, 1); clearCache();
const flood = (n) => call({ type: "assistant-request", call: vcall(`flood${n}`, { customer: { number: "+15550001111" } }) });
const f1 = await flood(1), f2 = await flood(2);
const other = await call({ type: "assistant-request", call: vcall("real_caller") });
check("same caller over its cap → rejected (call ends, no human line used)", () => {
  assert.deepEqual(f1.body, { squadId: "squad_edge" });
  assert.equal(f2.body.destination, undefined);
  assert.match(f2.body.error ?? "", /too many concurrent calls/);
});
check("a different caller still gets the remaining line", () => assert.deepEqual(other.body, { squadId: "squad_edge" }));
for (const id of ["flood1", "real_caller"]) await call({ type: "end-of-call-report", call: vcall(id) });
prof(ALWAYS); clearCache();

await call({ type: "assistant-request", call: vcall("cb") });
r = await call({ type: "tool-calls", call: vcall("cb"), toolCallList: [tool("t8", "log_callback_request", { topic: "billing" })] });
{
  const sql = postgres(DB_URL, { max: 1 });
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT voice.set_tenant(${TENANT})`;
    return tx`SELECT k.purpose, k.consent_type, k.evidence_uri FROM voice.consents k JOIN voice.contacts c ON c.id = k.contact_id WHERE c.e164 = ${callerFor("cb")}`;
  });
  await sql.end();
  check("log_callback_request records express callback consent with the call as evidence", () =>
    assert.deepEqual([...rows], [{ purpose: "callback", consent_type: "express", evidence_uri: `vapi:call/cb_${RUN}` }]));
}
await call({ type: "end-of-call-report", call: vcall("cb") });

r = await call({ type: "assistant-request", call: vcall("c9") }, { e: env(1) });
check("DB down → last-known-good failover destination", () => assert.deepEqual(r.body?.destination?.number, "+18005550100"));

kv.clear();
r = await call({ type: "assistant-request", call: { ...vcall("c10"), phoneNumberId: "ph_unknown" } });
check("unknown number → 403, never another tenant's assistant", () => assert.equal(r.status, 403));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
for (const s of [primary, secondary, events, control]) s.close();
process.exit(fails ? 1 : 0);
