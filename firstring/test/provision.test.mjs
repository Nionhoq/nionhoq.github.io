import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { startMocks } from "./mocks.mjs";
import { example } from "./helpers.mjs";
import { validateClient } from "../lib/validate.mjs";
import { buildAssistant } from "../assistant/build.mjs";
import { clientSecret } from "../lib/vapi.mjs";

const provision = new URL("../provision.mjs", import.meta.url).pathname;
const run = (file, env, ...flags) => new Promise((r) => execFile(process.execPath, [provision, file, ...flags], { env: { ...process.env, ...env } }, (err, stdout, stderr) => r({ code: err?.code ?? 0, stdout, stderr })));

test("validation: schema, cross-field rules, placeholders, warnings", () => {
  const base = example();
  assert.deepEqual(validateClient(base).errors, []);
  const bad = (fn) => { const c = example(); fn(c); return validateClient(c).errors.join(" | "); };
  assert.match(bad((c) => { c.timezone = "Mars/Base"; }), /IANA/);
  assert.match(bad((c) => { c.hours.mon = [["18:00", "08:00"]]; }), /start must be before end/);
  assert.match(bad((c) => { c.services.push({ ...c.services[0] }); }), /duplicate key/);
  assert.match(bad((c) => { c.phone.owner_mobile = c.phone.twilio_number; }), /owner's own mobile/);
  assert.match(bad((c) => { c.phone.owner_mobile = "+1416555011"; }), /pattern/);
  assert.match(bad((c) => { c.api_key = "sk-123"; }), /additional properties/);
  assert.match(validateClient(example(), { others: [{ ...example(), id: "other" }] }).errors.join(), /already used by client other/);
  const raw = JSON.parse(readFileSync(new URL("../clients/example-autoshop.json", import.meta.url)));
  assert.match(validateClient(raw, { apply: true }).errors.join(), /REPLACE placeholders/);
  const w = example(); w.booking.shadow_mode = false; w.minutes_cap = 0;
  assert.match(validateClient(w).warnings.join(" | "), /rule 4.*\|.*unlimited/);
});

test("assistant: disclosure greeting, per-client secret, tier-gated tools, KB in prompt", () => {
  const cfg = example();
  const a = buildAssistant(cfg, { webhookBase: "https://n8n.x.com/", masterSecret: "m", crypto });
  assert.match(a.firstMessage, /^Hi, you've reached Maple Auto Care\. I'm the automated assistant, and this call may be recorded/);
  const fn = a.model.tools.filter((t) => t.type === "function");
  assert.ok(fn.every((t) => t.server.url === "https://n8n.x.com/webhook/firstring-vapi?client=maple-auto" && t.server.secret === clientSecret(crypto, "m", "maple-auto")));
  assert.equal(a.server.secret, clientSecret(crypto, "m", "maple-auto"));
  assert.match(a.model.messages[0].content, /Oil change \(key oil_change\): \$89\.99/);
  assert.match(a.model.messages[0].content, /requests the shop confirms by text/);
  cfg.tier = "essential"; cfg.recording = false;
  const e = buildAssistant(cfg, { webhookBase: "https://n8n.x.com", masterSecret: "m", crypto });
  assert.deepEqual(e.model.tools.map((t) => t.function.name), ["escalate_to_owner", "take_message", "end_call"]);
  assert.doesNotMatch(e.firstMessage, /recorded/);
  assert.match(e.model.messages[0].content, /cannot book appointments on this line/);
});

test("provision --apply: Google, Vapi assistant + number import, Twilio webhooks, n8n; idempotent re-run", async () => {
  const mocks = await startMocks();
  try {
    const dir = mkdtempSync(join(tmpdir(), "fr-"));
    const cfg = example();
    cfg.phone.twilio_number = "+16475550100";
    writeFileSync(join(dir, "maple-auto.json"), JSON.stringify(cfg));
    mocks.state.vapi.phones = []; // not yet imported into Vapi
    mocks.state.sheets.set(cfg.google.sheet_id, new Map());
    const env = { ...mocks.env, N8N_API_URL: mocks.base, N8N_API_KEY: "n8n-key", FIRSTRING_WEBHOOK_BASE: "https://n8n.firstring.ca" };

    const r1 = await run(join(dir, "maple-auto.json"), env, "--apply");
    assert.equal(r1.code, 0, r1.stderr + r1.stdout);
    const st = JSON.parse(readFileSync(join(dir, "maple-auto.state.json")));
    assert.ok(st.assistantId);
    const asst = mocks.state.vapi.assistants.get(st.assistantId);
    assert.equal(asst.name, "firstring-maple-auto");
    const ph = mocks.state.vapi.phones[0];
    assert.equal(ph.number, "+16475550100");
    assert.equal(ph.assistantId, st.assistantId);
    assert.deepEqual(ph.fallbackDestination, { type: "number", number: "+14165550111" });
    assert.deepEqual(mocks.state.twilioUpdates[0], { sid: "PN1", SmsUrl: "https://n8n.firstring.ca/webhook/firstring-twilio-sms", SmsMethod: "POST",
      VoiceFallbackUrl: "https://n8n.firstring.ca/webhook/firstring-twilio-voice", VoiceFallbackMethod: "POST" });
    assert.deepEqual([...mocks.state.sheets.get(cfg.google.sheet_id).keys()], ["calls", "actions", "sms"]);
    const wfs = [...mocks.state.n8n.values()];
    assert.deepEqual(wfs.map((w) => w.name), ["firstring-errors", "firstring-vapi", "firstring-twilio-sms", "firstring-twilio-voice", "firstring-hourly"]);
    assert.ok(wfs.every((w) => w.active));
    assert.ok(wfs.slice(1).every((w) => w.settings.errorWorkflow === "wf1"));
    assert.match(wfs[1].nodes[1].parameters.jsCode, /"maple-auto"/);

    const r2 = await run(join(dir, "maple-auto.json"), env, "--apply");
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(mocks.state.vapi.assistants.size, 1, "assistant updated, not duplicated");
    assert.equal(mocks.state.vapi.phones.length, 1, "number not re-imported");
    assert.equal(mocks.state.n8n.size, 5, "workflows updated, not duplicated");
    assert.match(r2.stdout, /updated assistant/);
  } finally { await mocks.close(); }
});

test("provision stops before touching Vapi when the calendar isn't shared", async () => {
  const mocks = await startMocks();
  try {
    const dir = mkdtempSync(join(tmpdir(), "fr-"));
    const cfg = example();
    writeFileSync(join(dir, "c.json"), JSON.stringify(cfg));
    const env = { ...mocks.env, GOOGLE_SA_KEY: crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey,
      N8N_API_URL: mocks.base, N8N_API_KEY: "n8n-key" };
    const r = await run(join(dir, "c.json"), env, "--apply");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /google token 401/);
    assert.equal(mocks.state.vapi.assistants.size, 0);
    assert.equal(existsSync(join(dir, "c.state.json")), false);
  } finally { await mocks.close(); }
});
