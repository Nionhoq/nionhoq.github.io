// Client config → Vapi assistant spec. Every client is this template; nothing is hand-edited in Vapi.
import { TOOL_SCHEMAS, voiceSystemPrompt, greeting } from "../lib/prompt.mjs";
import { toolNames } from "../lib/tools.mjs";
import { clientSecret } from "../lib/vapi.mjs";

/**
 * @param {object} cfg client config
 * @param {{ webhookBase: string, masterSecret: string, crypto: object }} env
 */
export function buildAssistant(cfg, env) {
  const url = `${env.webhookBase.replace(/\/$/, "")}/webhook/firstring-vapi?client=${encodeURIComponent(cfg.id)}`;
  const secret = clientSecret(env.crypto, env.masterSecret, cfg.id);
  const allowed = toolNames(cfg);
  return {
    name: `firstring-${cfg.id}`.slice(0, 40),
    firstMessage: greeting(cfg),
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "openai",
      model: "gpt-4.1-mini",
      temperature: 0.3,
      maxTokens: 300,
      messages: [{ role: "system", content: voiceSystemPrompt(cfg) }],
      tools: [
        ...TOOL_SCHEMAS.filter((t) => allowed.includes(t.function.name)).map((t) => ({
          type: "function",
          function: t.function,
          ...(t.filler ? { messages: [{ type: "request-start", content: t.filler }] } : {}),
          server: { url, secret, timeoutSeconds: 10 },
        })),
        { type: "endCall", function: { name: "end_call", description: "End the call once the caller's needs are handled." } },
      ],
    },
    voice: { provider: cfg.voice?.provider ?? "11labs", voiceId: cfg.voice?.voice_id ?? "21m00Tcm4TlvDq8ikWAM", model: "eleven_flash_v2_5", optimizeStreamingLatency: 3 },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en", keywords: [] },
    startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: "livekit" } },
    backgroundDenoisingEnabled: true, // shop noise: compressors, impact guns
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,
    endCallMessage: `Thanks for calling ${cfg.name}. Bye for now.`,
    artifactPlan: { recordingEnabled: cfg.recording, transcriptPlan: { enabled: true } },
    analysisPlan: {
      summaryPlan: { enabled: true },
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["booked", "booking_requested", "rescheduled", "cancelled", "question_answered", "message_taken", "escalated", "hung_up", "other"] },
          },
        },
      },
    },
    serverMessages: ["end-of-call-report", "tool-calls"],
    server: { url, secret, timeoutSeconds: 20 },
    metadata: { firstringClient: cfg.id, template: "firstring-v1" },
  };
}
