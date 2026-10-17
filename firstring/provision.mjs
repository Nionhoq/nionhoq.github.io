#!/usr/bin/env node
// FirstRing client provisioning. Dry run by default.
//
//   node provision.mjs clients/<id>.json            validate + print the assistant and the plan
//   node provision.mjs clients/<id>.json --apply    provision this client and redeploy n8n for all clients
//
// Env (--apply): VAPI_API_KEY, FIRSTRING_MASTER_SECRET, FIRSTRING_WEBHOOK_BASE, N8N_API_URL, N8N_API_KEY,
//                TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, GOOGLE_SA_EMAIL, GOOGLE_SA_KEY
// Idempotent: the Vapi assistant id is kept in clients/<id>.state.json (gitignored) and PATCHed on re-runs.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import crypto from "node:crypto";
import { validateClient } from "./lib/validate.mjs";
import { buildAssistant } from "./assistant/build.mjs";
import { makeCtx } from "./lib/runtime.mjs";
import { google } from "./lib/google.mjs";
import { TABS } from "./lib/log.mjs";
import { deployWorkflows } from "./n8n/deploy.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const file = args.find((a) => !a.startsWith("--"));
if (!file) die("usage: node provision.mjs clients/<id>.json [--apply]");

const env = process.env;
const dir = dirname(file);
const cfg = readJson(file);
const others = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".state.json") && join(dir, f) !== file).map((f) => readJson(join(dir, f)));
const { errors, warnings } = validateClient(cfg, { apply, others });
warnings.forEach((w) => console.error(`warn: ${w}`));
if (errors.length) { errors.forEach((e) => console.error(`error: ${e}`)); process.exit(2); }

const webhookBase = env.FIRSTRING_WEBHOOK_BASE ?? "https://n8n.example.com";
const assistant = buildAssistant(cfg, { webhookBase, masterSecret: env.FIRSTRING_MASTER_SECRET ?? "dry-run", crypto });

if (!apply) {
  const redacted = JSON.parse(JSON.stringify(assistant, (k, v) => (k === "secret" ? "***" : v)));
  console.log(JSON.stringify({
    mode: "dry-run",
    client: cfg.id,
    tools: assistant.model.tools.map((t) => t.function.name),
    greeting: assistant.firstMessage,
    plan: [
      `Vapi: ${existsSync(statePath()) ? "update" : "create"} assistant ${assistant.name}`,
      `Vapi: import/bind ${cfg.phone.twilio_number} → assistant, fallback → ${cfg.phone.owner_mobile}`,
      `Twilio: SMS webhook → ${webhookBase}/webhook/firstring-twilio-sms; voice fallback → ${webhookBase}/webhook/firstring-twilio-voice`,
      `Google: ensure tabs ${Object.keys(TABS).join(", ")} in sheet ${cfg.google.sheet_id}; check calendar access`,
      `n8n: redeploy 5 shared workflows with ${1 + others.length} client(s)`,
    ],
    assistant: redacted,
  }, null, 2));
  process.exit(0);
}

for (const k of ["VAPI_API_KEY", "FIRSTRING_MASTER_SECRET", "FIRSTRING_WEBHOOK_BASE", "N8N_API_URL", "N8N_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "GOOGLE_SA_EMAIL", "GOOGLE_SA_KEY"]) {
  if (!env[k]) die(`missing env ${k}`);
}
const VAPI = env.VAPI_API_BASE ?? "https://api.vapi.ai";
const TWILIO = env.TWILIO_API_BASE ?? "https://api.twilio.com";
const ctx = makeCtx({ env, clients: {}, crypto });

try {
  // 1. Google first: if the calendar/sheet aren't shared with the service account, stop before touching anything else.
  const g = google(ctx);
  await g.calendar.list(cfg.google.calendar_id, new Date(), new Date(Date.now() + 86_400_000));
  const added = await g.sheets.ensureTabs(cfg.google.sheet_id, TABS);
  log(`google: calendar reachable; sheet tabs ${added.length ? `created ${added.join(", ")}` : "already present"}`);

  // 2. Vapi assistant (create once, then PATCH; id persisted immediately).
  const state = existsSync(statePath()) ? readJson(statePath()) : {};
  if (state.assistantId) {
    await vapi("PATCH", `/assistant/${state.assistantId}`, assistant);
    log(`vapi: updated assistant ${state.assistantId}`);
  } else {
    state.assistantId = (await vapi("POST", "/assistant", assistant)).id;
    writeFileSync(statePath(), JSON.stringify(state, null, 2));
    log(`vapi: created assistant ${state.assistantId}`);
  }

  // 3. Vapi phone number: import from Twilio if needed, bind to the assistant, fall back to the owner.
  const binding = { assistantId: state.assistantId, fallbackDestination: { type: "number", number: cfg.phone.owner_mobile } };
  const phones = await vapi("GET", "/phone-number");
  let phone = phones.find((p) => p.number === cfg.phone.twilio_number);
  if (phone) {
    await vapi("PATCH", `/phone-number/${phone.id}`, binding);
  } else {
    phone = await vapi("POST", "/phone-number", { provider: "twilio", number: cfg.phone.twilio_number, twilioAccountSid: env.TWILIO_ACCOUNT_SID, twilioAuthToken: env.TWILIO_AUTH_TOKEN, name: `firstring-${cfg.id}`, ...binding });
  }
  state.vapiPhoneId = phone.id;
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
  log(`vapi: ${cfg.phone.twilio_number} → assistant (fallback ${cfg.phone.owner_mobile})`);

  // 4. Twilio: SMS + voice-fallback webhooks. VoiceUrl stays Vapi's.
  const tw = await twilio("GET", `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(cfg.phone.twilio_number)}`);
  const sid = tw.incoming_phone_numbers?.[0]?.sid;
  if (!sid) throw new Error(`${cfg.phone.twilio_number} is not in this Twilio account`);
  await twilio("POST", `/IncomingPhoneNumbers/${sid}.json`, {
    SmsUrl: `${webhookBase}/webhook/firstring-twilio-sms`, SmsMethod: "POST",
    VoiceFallbackUrl: `${webhookBase}/webhook/firstring-twilio-voice`, VoiceFallbackMethod: "POST",
  });
  log("twilio: SMS webhook + voice fallback set");

  // 5. n8n: redeploy the shared workflows with every valid client embedded.
  const all = Object.fromEntries([cfg, ...others.filter((o) => !validateClient(o, { apply: true }).errors.length)].map((c) => [c.id, c]));
  const ids = await deployWorkflows({ apiUrl: env.N8N_API_URL, apiKey: env.N8N_API_KEY, clients: all, log: (m) => log(`n8n: ${m}`) });
  log(`done: ${cfg.id} live on ${cfg.phone.twilio_number} (${Object.keys(ids).length} workflows, ${Object.keys(all).length} clients)`);
  log(cfg.booking.shadow_mode ? "shadow mode ON: bookings wait for the owner's YES" : "shadow mode OFF: bookings are confirmed immediately");
  log(`next: shop forwards its line to ${cfg.phone.twilio_number}; run the 5-scenario test calls (README §6)`);
} catch (e) {
  console.error(`failed: ${e.message}`);
  process.exitCode = 1;
}

async function vapi(method, path, body) {
  return http(`${VAPI}${path}`, method, body ? JSON.stringify(body) : undefined, { authorization: `Bearer ${env.VAPI_API_KEY}`, "content-type": "application/json" });
}
async function twilio(method, path, form) {
  return http(`${TWILIO}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`, method, form ? new URLSearchParams(form).toString() : undefined, {
    authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
    ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
  });
}
async function http(url, method, body, headers) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (res.ok) { const t = await res.text(); return t ? JSON.parse(t) : null; }
    if (!(res.status === 0 || res.status === 429 || res.status >= 500) || attempt >= 3) throw new Error(`${method} ${new URL(url).pathname} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}
function statePath() { return join(dir, `${basename(file, ".json")}.state.json`); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function log(m) { console.log(`[provision] ${m}`); }
function die(m) { console.error(m); process.exit(2); }
