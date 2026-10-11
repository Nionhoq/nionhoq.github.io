import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate, buildAssistants, buildSquad, phoneBinding } from "../lib/build.mjs";

const base = () => JSON.parse(readFileSync(new URL("../examples/acme.client_config.json", import.meta.url)));
const env = { edgeBaseUrl: "https://edge.test", webhookSecret: "s3cr3t" };
const mut = (fn) => { const c = base(); fn(c); return c; };

test("example config is valid for dry-run, placeholder voices block --apply", () => {
  assert.deepEqual(validate(base()).errors, []);
  const { errors } = validate(base(), { apply: true });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /placeholder/);
});

test("schema rejects secrets and unknown fields", () => {
  const { errors } = validate(mut((c) => { c.vapi_assistant.server_secret = "abc"; }));
  assert.ok(errors.some((e) => /additional properties/.test(e)));
});

test("HIPAA requires BAA, forbids recording, caps retention", () => {
  const { errors } = validate(mut((c) => { c.compliance.hipaa_mode = true; }));
  assert.ok(errors.some((e) => /baa_verified_at/.test(e)));
  assert.ok(errors.some((e) => /recording_enabled/.test(e)));
  const ok = mut((c) => Object.assign(c.compliance, { hipaa_mode: true, recording_enabled: false, baa_verified_at: "2026-09-01T00:00:00Z" }));
  assert.deepEqual(validate(ok).errors, []);
});

test("Quebec requires PIA and French; underscore jurisdiction accepted", () => {
  const { errors } = validate(mut((c) => { c.compliance.jurisdiction = "CA_QC"; c.localization.supported_languages = ["en-US"]; }));
  assert.ok(errors.some((e) => /pia_completed_at/.test(e)));
  const e2 = validate(mut((c) => { c.compliance.jurisdiction = "CA_QC"; c.compliance.pia_completed_at = "2026-09-01T00:00:00Z"; c.localization.supported_languages = ["en-US"]; })).errors;
  assert.ok(e2.some((e) => /fr-CA/.test(e)));
});

test("cross-field: default language, failover loop, unsupported locale", () => {
  assert.ok(validate(mut((c) => { c.localization.default_language = "es-US"; c.localization.supported_languages = ["en-US"]; })).errors.some((e) => /default_language/.test(e)));
  assert.ok(validate(mut((c) => { c.telephony.failover_routing_number = "+18005550199"; })).errors.some((e) => /loop/.test(e)));
  assert.ok(validate(mut((c) => { c.localization.supported_languages = ["de-DE"]; })).errors.length > 0);
});

test("warns when server_url points straight at n8n", () => {
  const { warnings } = validate(mut((c) => { c.vapi_assistant.server_url = "https://n8n.yourdomain.com/webhook/vapi-tool-call"; }));
  assert.ok(warnings.some((w) => /n8n/.test(w)));
});

test("squad mode: one assistant per locale with correct STT/TTS and cross handoffs", () => {
  const c = mut((c) => { c.vapi_assistant.voice.voices_by_language = { "fr-CA": "fr_voice" }; });
  const as = buildAssistants(c, env);
  assert.deepEqual(as.map((a) => a.key), ["en-US", "fr-CA", "es-US"]);
  const by = Object.fromEntries(as.map((a) => [a.key, a.spec]));
  assert.equal(by["fr-CA"].transcriber.language, "fr-CA");
  assert.equal(by["es-US"].transcriber.language, "es-419");
  assert.equal(by["fr-CA"].voice.voiceId, "fr_voice");
  assert.equal(by["es-US"].voice.voiceId, "21m00Tcm4TlvDq8ikWAM");
  assert.equal(by["en-US"].voice.provider, "11labs");
  assert.match(by["fr-CA"].firstMessage, /^Bonjour.*enregistré/);
  assert.equal(by["en-US"].server.timeoutSeconds, 3);
  assert.equal(by["en-US"].server.url, "https://edge.test/webhook/vapi-tool-call");
  for (const t of by["en-US"].model.tools.filter((t) => t.server)) assert.equal(t.server.url, "https://edge.test/webhook/vapi-tool-call");
  const squad = buildSquad(c, { "en-US": "a1", "fr-CA": "a2", "es-US": "a3" });
  assert.equal(squad.members[0].assistantId, "a1");
  assert.deepEqual(squad.members[1].assistantDestinations.map((d) => d.assistantName), ["client_enterprise_101-en-US", "client_enterprise_101-es-US"]);
});

test("auto-detect: single multilingual assistant, no squad", () => {
  const c = mut((c) => { c.localization.auto_detect_language = true; });
  const as = buildAssistants(c, env);
  assert.equal(as.length, 1);
  assert.equal(as[0].key, "multi");
  assert.equal(as[0].spec.transcriber.language, "multi");
  assert.match(as[0].spec.model.messages[0].content, /English, French \(Canada\), Spanish \(US\)/);
  assert.equal(buildSquad(c, {}), null);
});

test("HIPAA build disables recording and summaries; no-recording disclosure", () => {
  const c = mut((c) => Object.assign(c.compliance, { hipaa_mode: true, recording_enabled: false, baa_verified_at: "2026-09-01T00:00:00Z" }));
  const [en] = buildAssistants(c, env);
  assert.equal(en.spec.compliancePlan.hipaaEnabled, true);
  assert.equal(en.spec.artifactPlan.recordingEnabled, false);
  assert.equal(en.spec.analysisPlan.summaryPlan.enabled, false);
  assert.doesNotMatch(en.spec.firstMessage, /recorded/);
});

test("phone binding clears static assistant so assistant-request reaches the edge", () => {
  assert.deepEqual(phoneBinding(env), { assistantId: null, squadId: null, server: { url: "https://edge.test/webhook/vapi-tool-call", timeoutSeconds: 3, secret: "s3cr3t" } });
});
