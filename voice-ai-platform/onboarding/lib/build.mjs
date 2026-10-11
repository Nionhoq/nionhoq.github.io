// Pure functions: client_config.json → validated, normalised config → VAPI resource specs.
// No I/O here, so the whole build can be unit-tested and diffed in --dry-run.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export const SCHEMA = readJson(join(root, "onboarding", "client_config.schema.json"));
export const LANG = readJson(join(root, "onboarding", "language-map.json"));
const TOOLS = readJson(join(root, "vapi", "tools.json")).tools;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(SCHEMA);

/** @returns {{ errors: string[], warnings: string[] }} */
export function validate(cfg, { apply = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!validateSchema(cfg)) {
    for (const e of validateSchema.errors) errors.push(`${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : ""}`);
    return { errors, warnings };
  }
  const { localization: loc, telephony: tel, compliance: c, vapi_assistant: va } = cfg;
  const jur = normJurisdiction(c.jurisdiction);

  if (!loc.supported_languages.includes(loc.default_language)) errors.push("/localization default_language must be in supported_languages");
  if (jur === "CA-QC" && !loc.supported_languages.includes("fr-CA")) errors.push("/localization CA-QC (Charter of the French Language) requires fr-CA support");
  const own = new Set(tel.phone_numbers.map((p) => p.number));
  if (own.has(tel.failover_routing_number)) errors.push("/telephony failover_routing_number must not be one of the client's own AI-handled numbers (it would loop)");
  if (tel.after_hours_routing_number && own.has(tel.after_hours_routing_number)) errors.push("/telephony after_hours_routing_number must not be one of the client's own AI-handled numbers (it would loop)");
  if (tel.business_hours) {
    if (!validTimeZone(tel.business_hours.timezone)) errors.push(`/telephony/business_hours timezone "${tel.business_hours.timezone}" is not a valid IANA zone`);
    for (const [day, ranges] of Object.entries(tel.business_hours.weekly)) {
      for (const [a, b] of ranges) if (a >= b) errors.push(`/telephony/business_hours ${day} ${a}-${b}: start must be before end`);
    }
    if (!tel.after_hours_routing_number) warnings.push("business_hours set without after_hours_routing_number: after-hours hand-offs will ring the daytime line");
  } else {
    warnings.push("no business_hours: the failover line is assumed staffed 24/7 (busy, outage and transfer calls all go there)");
  }
  if (own.size !== tel.phone_numbers.length) errors.push("/telephony duplicate phone number");

  for (const [lang, id] of Object.entries(va.voice.voices_by_language ?? {})) {
    if (!loc.supported_languages.includes(lang)) warnings.push(`voices_by_language.${lang} is set but ${lang} is not supported; ignored`);
    if (id.startsWith("REPLACE_")) (apply ? errors : warnings).push(`voices_by_language.${lang} is a placeholder`);
  }
  if (va.server_url && /n8n/i.test(va.server_url)) {
    warnings.push("server_url looks like an n8n host. VAPI should hit the edge worker; n8n sits behind it (see README §1).");
  }
  if (va.transcriber?.language && loc.supported_languages.length > 1) {
    warnings.push("vapi_assistant.transcriber.language is ignored for multi-language clients; per-language codes come from language-map.json");
  }
  if (jur.startsWith("CA") && c.pipeda_consent_required === false) warnings.push("pipeda_consent_required=false for a Canadian jurisdiction: confirm with counsel");
  if (c.hipaa_mode && /^(gpt|o\d)/.test(va.model) && inferProvider(va) === "openai") {
    warnings.push("HIPAA mode with OpenAI: requires an executed BAA with OpenAI (or use azure-openai under Microsoft's BAA)");
  }
  return { errors, warnings };
}

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export function normJurisdiction(j) {
  return j.replace("_", "-");
}

export function inferProvider(va) {
  if (va.model_provider) return va.model_provider;
  if (/^claude/.test(va.model)) return "anthropic";
  if (/^(llama|mixtral|gemma|qwen|deepseek)/i.test(va.model)) return "groq";
  return "openai";
}

const voiceProvider = (p) => (p === "elevenlabs" ? "11labs" : p);

export function assistantName(cfg, lang) {
  return `${cfg.client_id}-${lang ?? "multi"}`.slice(0, 40); // VAPI caps assistant names (~40 chars)
}

/**
 * Build the VAPI assistant specs. One per language (squad mode) or a single multilingual one.
 * @param {object} cfg validated config
 * @param {{ edgeBaseUrl: string, webhookSecret: string }} env
 */
export function buildAssistants(cfg, env) {
  const loc = cfg.localization;
  const langs = loc.supported_languages;
  const auto = loc.auto_detect_language || langs.length === 1;
  const targets = auto ? [loc.default_language] : langs;

  return targets.map((lang) => {
    const L = LANG.locales[lang];
    const multi = auto && langs.length > 1;
    const transcriber = multi
      ? { provider: "deepgram", ...LANG.auto_detect.deepgram }
      : { provider: "deepgram", ...L.deepgram, ...(langs.length === 1 ? stripUndefined(cfg.vapi_assistant.transcriber) : {}) };
    const replyRule = multi
      ? LANG.auto_detect.reply_rule
          .replace("{labels}", langs.map((l) => LANG.locales[l].label).join(", "))
          .replace("{default_label}", LANG.locales[loc.default_language].label)
      : L.reply_rule;

    return {
      key: multi ? "multi" : lang,
      spec: {
        name: assistantName(cfg, multi ? null : lang),
        firstMessage: fill(cfg.compliance.recording_enabled ? L.first_message : L.first_message_no_recording, cfg),
        firstMessageMode: "assistant-speaks-first",
        model: {
          provider: inferProvider(cfg.vapi_assistant),
          model: cfg.vapi_assistant.model,
          temperature: 0.3,
          maxTokens: 250,
          messages: [{ role: "system", content: systemPrompt(cfg, replyRule) }],
          tools: tools(env),
        },
        voice: voiceSpec(cfg, lang, multi),
        transcriber,
        startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: "livekit" } },
        stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.2, backoffSeconds: 1 },
        backgroundDenoisingEnabled: true,
        silenceTimeoutSeconds: 20,
        maxDurationSeconds: 900,
        endCallMessage: fill(L.end_call_message, cfg),
        compliancePlan: { hipaaEnabled: cfg.compliance.hipaa_mode, pciEnabled: false },
        artifactPlan: { recordingEnabled: cfg.compliance.recording_enabled && !cfg.compliance.hipaa_mode },
        analysisPlan: { summaryPlan: { enabled: !cfg.compliance.hipaa_mode } },
        serverMessages: ["end-of-call-report", "status-update", "tool-calls", "transfer-destination-request", "hang"],
        server: { url: webhookUrl(env), timeoutSeconds: 3, secret: env.webhookSecret },
        metadata: { clientId: cfg.client_id, language: multi ? "multi" : lang, schemaVersion: "2" },
      },
    };
  });
}

/** Squad only when >1 language and auto-detect is off. Every member can hand off to every other. */
export function buildSquad(cfg, assistantIds) {
  const langs = cfg.localization.supported_languages;
  if (cfg.localization.auto_detect_language || langs.length < 2) return null;
  const ordered = [cfg.localization.default_language, ...langs.filter((l) => l !== cfg.localization.default_language)];
  return {
    name: `${cfg.client_id}-squad`.slice(0, 40),
    members: ordered.map((lang) => ({
      assistantId: assistantIds[lang],
      assistantDestinations: ordered
        .filter((other) => other !== lang)
        .map((other) => ({
          type: "assistant",
          assistantName: assistantName(cfg, other),
          description: LANG.locales[other].handoff_description,
          message: "",
        })),
    })),
  };
}

export function phoneBinding(env) {
  // No static assistant on the number: VAPI sends assistant-request to the edge,
  // which runs the concurrency gate and returns the squad/assistant (or the failover destination).
  return { assistantId: null, squadId: null, server: { url: webhookUrl(env), timeoutSeconds: 3, secret: env.webhookSecret } };
}

export function kvProfile(cfg) {
  const def = cfg.localization.default_language;
  const tel = cfg.telephony;
  return {
    name: cfg.client_name,
    language: def,
    transferNumber: tel.failover_routing_number,
    afterHoursNumber: tel.after_hours_routing_number ?? null,
    businessHours: tel.business_hours ?? null,
    maxPerCaller: tel.max_concurrent_calls_per_caller ?? 2,
    busyMessage: LANG.locales[def].busy_message,
    afterHoursMessage: LANG.locales[def].after_hours_message,
    recordingEnabled: cfg.compliance.recording_enabled && !cfg.compliance.hipaa_mode,
  };
}

export const webhookUrl = (env) => `${env.edgeBaseUrl.replace(/\/$/, "")}/webhook/vapi-tool-call`;

function tools(env) {
  return TOOLS.map(({ $comment, ...t }) => (t.server ? { ...t, server: { ...t.server, url: webhookUrl(env), secret: env.webhookSecret } } : t));
}

function voiceSpec(cfg, lang, multi) {
  const v = cfg.vapi_assistant.voice;
  const id = (!multi && v.voices_by_language?.[lang]) || v.voice_id;
  if (v.provider === "cartesia") {
    return { provider: "cartesia", voiceId: id, model: "sonic-2", language: multi ? undefined : LANG.locales[lang].cartesia_language };
  }
  return { provider: voiceProvider(v.provider), voiceId: id, model: multi ? LANG.auto_detect.elevenlabs_model : LANG.locales[lang].elevenlabs_model, optimizeStreamingLatency: 3 };
}

function systemPrompt(cfg, replyRule) {
  return [
    `You are the phone assistant for ${cfg.client_name}.`,
    replyRule,
    "",
    "STYLE: short sentences, one question at a time, no lists or URLs read aloud.",
    "",
    "HARD RULES (also enforced server-side):",
    "- You are an AI. If asked whether you are human, say you are an automated assistant.",
    "- If the caller asks not to be called again (stop calling, remove me, do not call): call request_opt_out immediately, confirm, end the call.",
    "- Never ask for or repeat full card numbers, SSNs/SINs, or full dates of birth.",
    "- Do not discuss account, medical, or appointment details until verify_identity succeeds.",
    "- Medical emergency: tell the caller to hang up and dial 9-1-1, then transfer_to_human.",
    "- Out of scope, unsure, or caller asks for a person: transfer_to_human.",
    "- If a tool says it is transferring you, stop talking and let the transfer happen.",
  ].join("\n");
}

const fill = (s, cfg) => s.replaceAll("{name}", cfg.client_name);
const stripUndefined = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => v !== undefined && k !== "provider"));
