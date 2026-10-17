// Real n8n end-to-end: boots n8n (N8N_BIN), deploys the generated workflows through the public API,
// then drives them over HTTP exactly as Vapi and Twilio would, against the mock APIs.
// Run: N8N_BIN=/path/to/node_modules/.bin/n8n node test/n8n-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { startMocks, setupSheet, twilioSign } from "./mocks.mjs";
import { example, slotIds, bookingIds } from "./helpers.mjs";
import { clientSecret } from "../lib/vapi.mjs";
import { deployWorkflows } from "../n8n/deploy.mjs";

// N8N_EXTERNAL_URL: reuse an n8n already started with this script's env (first boot migrations are slow).
// The mocks then listen on a fixed port (MOCK_PORT) so that n8n's env can point at them.
const PORT = 5678; // n8n's task broker defaults to 5679
const BASE = process.env.N8N_EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`;
const mocks = await startMocks(Number(process.env.MOCK_PORT ?? 0));
const cfg = example();
cfg.booking.shadow_mode = true;
setupSheet(mocks.state, cfg.google.sheet_id);
mocks.state.sheets.set("ops-sheet", new Map([["errors", [["at", "workflow", "node", "text", "execution"]]]]));

const home = process.env.N8N_E2E_HOME ?? mkdtempSync(join(tmpdir(), "n8n-e2e-"));
const env = {
  ...process.env, ...mocks.env,
  FIRSTRING_WEBHOOK_BASE: BASE, FIRSTRING_OPS_SHEET_ID: "ops-sheet",
  N8N_USER_FOLDER: home, N8N_PORT: String(PORT), N8N_LISTEN_ADDRESS: "127.0.0.1",
  N8N_BLOCK_ENV_ACCESS_IN_NODE: "false", NODE_FUNCTION_ALLOW_BUILTIN: "crypto",
  N8N_DIAGNOSTICS_ENABLED: "false", N8N_PERSONALIZATION_ENABLED: "false", N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
  N8N_SECURE_COOKIE: "false", N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "false", DB_SQLITE_POOL_SIZE: "2",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
};
if (process.argv.includes("--print-env")) {
  for (const [k, v] of Object.entries(env)) if (!(k in process.env) || /^(N8N_|FIRSTRING_|NODE_FUNCTION|GOOGLE_|TWILIO_|OPENAI_|VAPI_|NION_|DB_|NO_PROXY|no_proxy)/.test(k)) console.log(`export ${k}=${JSON.stringify(v)}`);
  await mocks.close(); process.exit(0);
}
let n8nLog = "";
const n8n = process.env.N8N_EXTERNAL_URL ? null : spawn(process.env.N8N_BIN, ["start"], { env, stdio: ["ignore", "pipe", "pipe"] });
n8n?.stdout.on("data", (d) => (n8nLog += d));
n8n?.stderr.on("data", (d) => (n8nLog += d));
const stop = async (code) => { n8n?.kill("SIGTERM"); await mocks.close(); process.exit(code); };

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); console.log(`PASS  ${name}`); }
  catch (e) { results.push(["FAIL", name]); console.log(`FAIL  ${name}\n      ${e.message.split("\n").slice(0, 8).join("\n      ")}`); }
};

try {
  for (let i = 0; ; i++) {
    if (i > 900) throw new Error("n8n did not start:\n" + n8nLog.slice(-2000));
    try { if ((await fetch(`${BASE}/healthz/readiness`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Owner + API key (what Nion does once in the n8n UI).
  let owner = await fetch(`${BASE}/rest/owner/setup`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nion@example.com", firstName: "Nion", lastName: "H", password: "Passw0rd!Passw0rd" }) });
  if (!owner.ok) { // already set up on a reused instance → log in
    owner = await fetch(`${BASE}/rest/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailOrLdapLoginId: "nion@example.com", password: "Passw0rd!Passw0rd" }) });
  }
  assert.ok(owner.ok, `owner setup/login ${owner.status} ${await owner.clone().text()}`);
  const cookie = owner.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const keyRes = await fetch(`${BASE}/rest/api-keys`, { method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ label: `firstring-e2e-${Date.now()}`, expiresAt: null, scopes: ["workflow:create", "workflow:read", "workflow:update", "workflow:list", "workflow:activate", "workflow:delete"] }) });
  const keyText = await keyRes.text();
  let keyBody; try { keyBody = JSON.parse(keyText); } catch { throw new Error(`api-keys ${keyRes.status}: ${keyText.slice(0, 300)}`); }
  assert.ok(keyRes.ok, `api key ${keyRes.status} ${JSON.stringify(keyBody)}`);
  const apiKey = keyBody.data?.rawApiKey ?? keyBody.data?.apiKey;

  await check("deploy: 5 workflows created and activated via the public API", async () => {
    const ids = await deployWorkflows({ apiUrl: BASE, apiKey, clients: { [cfg.id]: cfg } });
    assert.deepEqual(Object.keys(ids).sort(), ["firstring-errors", "firstring-hourly", "firstring-twilio-sms", "firstring-twilio-voice", "firstring-vapi"]);
  });
  await check("redeploy is an update, not a duplicate", async () => {
    const before = await deployWorkflows({ apiUrl: BASE, apiKey, clients: { [cfg.id]: cfg } });
    const after = await deployWorkflows({ apiUrl: BASE, apiKey, clients: { [cfg.id]: cfg } });
    assert.deepEqual(before, after);
  });
  await new Promise((r) => setTimeout(r, 1500));

  const secret = clientSecret(crypto, mocks.env.FIRSTRING_MASTER_SECRET, cfg.id);
  const vapi = async (message, s = secret) => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/webhook/firstring-vapi?client=${cfg.id}`, { method: "POST", headers: { "content-type": "application/json", "x-vapi-secret": s }, body: JSON.stringify({ message }) });
    return { status: res.status, ms: Date.now() - t0, type: res.headers.get("content-type"), body: await res.text() };
  };
  const toolMsg = (name, args, phone = "+19055551234") => ({ type: "tool-calls", call: { id: "call_e2e", customer: { number: phone } }, toolCallList: [{ id: `tc_${name}_${Math.random()}`, function: { name, arguments: args } }] });
  const result = (r) => JSON.parse(r.body).results[0].result;
  const twilio = async (path, params, query = "") => {
    const url = `${BASE}/webhook/${path}${query}`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSign("twilio-token", url, params) }, body: new URLSearchParams(params).toString() });
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  };

  await check("Vapi webhook rejects a bad secret with 401", async () => {
    assert.equal((await vapi(toolMsg("take_message", { summary: "x" }), "wrong")).status, 401);
  });
  let slot;
  await check("check_availability through n8n returns speakable times (and timing)", async () => {
    const r = await vapi(toolMsg("check_availability", { service: "oil change", day_of_week: "tuesday" }));
    assert.equal(r.status, 200, r.body);
    assert.match(r.type, /application\/json/);
    slot = slotIds(result(r))[0];
    assert.ok(slot, result(r));
    console.log(`      (round trip ${r.ms} ms)`);
  });
  await check("book_appointment (shadow mode) → tentative hold + owner approval text", async () => {
    const r = await vapi(toolMsg("book_appointment", { slot_id: slot, customer_name: "Sam", vehicle: "Civic" }));
    assert.match(result(r), /confirm by text/);
    const evs = [...mocks.state.events.get(cfg.google.calendar_id).values()];
    assert.equal(evs.length, 1);
    assert.equal(evs[0].status, "tentative");
    assert.match(mocks.state.sms.at(-1).body, /Reply YES \d{4}/);
  });
  await check("owner texts YES <code> → Twilio webhook (signed) confirms, TwiML reply", async () => {
    const code = /YES (\d{4})/.exec(mocks.state.sms.at(-1).body)[1];
    const r = await twilio("firstring-twilio-sms", { From: cfg.phone.owner_mobile, To: cfg.phone.twilio_number, Body: `YES ${code}` });
    assert.equal(r.status, 200, r.body);
    assert.match(r.type, /text\/xml/);
    assert.match(r.body, /<Message>Confirmed Sam/);
    assert.equal([...mocks.state.events.get(cfg.google.calendar_id).values()][0].status, "confirmed");
  });
  await check("forged Twilio signature → 403", async () => {
    const res = await fetch(`${BASE}/webhook/firstring-twilio-sms`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "forged" }, body: "From=%2B19055551234&To=%2B16475550100&Body=hi" });
    assert.equal(res.status, 403);
  });
  await check("find + cancel through n8n", async () => {
    const [bid] = bookingIds(result(await vapi(toolMsg("find_booking", {}))));
    assert.match(result(await vapi(toolMsg("cancel_booking", { booking_id: bid }))), /is cancelled/);
    assert.equal(mocks.state.events.get(cfg.google.calendar_id).size, 0);
  });
  await check("complaint escalation through n8n", async () => {
    const r = await vapi(toolMsg("escalate_to_owner", { category: "complaint", summary: "scratched my rim" }));
    assert.match(result(r), /call you back personally/);
    assert.match(mocks.state.sms.at(-1).body, /URGENT COMPLAINT/);
  });
  await check("end-of-call (hang-up) → text-back with STOP wording", async () => {
    const r = await vapi({ type: "end-of-call-report", call: { id: "call_h", customer: { number: "+19055550999" } }, durationSeconds: 3, artifact: { messages: [] }, analysis: {} });
    assert.equal(r.status, 200, r.body);
    assert.match(mocks.state.sms.at(-1).body, /Sorry we missed your call.*Reply STOP to opt out/);
  });
  await check("voice fallback returns TwiML <Dial> to the owner", async () => {
    const r = await twilio("firstring-twilio-voice", { From: "+19055551234", To: cfg.phone.twilio_number, CallSid: "CA9" });
    assert.match(r.body, /<Dial timeout="20" action="http:\/\/127\.0\.0\.1:5678\/webhook\/firstring-twilio-voice\?step=status">\+14165550111<\/Dial>/);
  });
  await check("a thrown error reaches firstring-errors → ops sheet + SMS to Nion (phone redacted)", async () => {
    mocks.state.sheets.get(cfg.google.sheet_id).delete("calls"); // make logging fail
    const r = await vapi({ type: "end-of-call-report", call: { id: "call_err", customer: { number: "+19055554321" } }, durationSeconds: 60, artifact: { messages: [{ role: "user", message: "hi" }] }, analysis: { summary: "x" } });
    assert.equal(r.status >= 500 || r.status === 200, true);
    for (let i = 0; i < 30 && mocks.state.sheets.get("ops-sheet").get("errors").length < 2; i++) await new Promise((x) => setTimeout(x, 500));
    const rows = mocks.state.sheets.get("ops-sheet").get("errors");
    assert.equal(rows.length, 2, "error row written");
    assert.equal(rows[1][1], "firstring-vapi");
    assert.match(mocks.state.sms.at(-1).body, /^FirstRing ERROR in firstring-vapi/);
    assert.doesNotMatch(mocks.state.sms.at(-1).body, /19055554321/);
  });
} catch (e) {
  console.log("SETUP FAILED:", e.message);
  console.log(n8nLog.slice(-3000));
  results.push(["FAIL", "setup"]);
}
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(failed ? `\n${failed} FAILED` : `\nALL ${results.length} PASS`);
if (failed) console.log("--- n8n log tail ---\n" + n8nLog.slice(-2500));
await stop(failed ? 1 : 0);
