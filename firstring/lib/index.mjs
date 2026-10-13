// Entry points called from the n8n Code nodes (and from tests).
// Each returns { status, contentType, body } for the Respond-to-Webhook node.
import { verifyVapi } from "./vapi.mjs";
import { verifyTwilio, nanp, twiml } from "./twilio.mjs";
import { runTool } from "./tools.mjs";
import { handleEndOfCall, handleInboundSms, handleVoiceFallback } from "./events.mjs";
import { google } from "./google.mjs";
import { sendSms } from "./twilio.mjs";
export { runHourly } from "./jobs.mjs";

const json = (status, body) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const xml = (body, status = 200) => ({ status, contentType: "text/xml", body });

export async function handleVapi(ctx, req) {
  const cfg = ctx.clients[req.query.client];
  if (!cfg) return json(404, { error: "unknown client" });
  if (!verifyVapi(ctx, cfg.id, lower(req.headers))) return json(401, { error: "unauthorized" });
  const msg = req.body?.message ?? {};
  switch (msg.type) {
    case "tool-calls": {
      const phone = nanp(msg.call?.customer?.number);
      const results = [];
      for (const tc of msg.toolCallList ?? []) {
        let args = tc.function?.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        let result;
        try {
          result = await runTool(ctx, cfg, tc.function?.name, args, { phone, callId: msg.call?.id, channel: "voice" });
        } catch (e) {
          if (ctx.reportError) await ctx.reportError(e, { client: cfg.id, tool: tc.function?.name, call: msg.call?.id });
          result = "I'm having trouble with our system right now. Let me take a message and the owner will call you back.";
        }
        results.push({ toolCallId: tc.id, result });
      }
      return json(200, { results });
    }
    case "end-of-call-report":
      await handleEndOfCall(ctx, cfg, msg);
      return json(200, { ok: true });
    default:
      return json(200, { ok: true, ignored: msg.type ?? null });
  }
}

export async function handleTwilioSms(ctx, req) {
  const url = `${ctx.env.FIRSTRING_WEBHOOK_BASE}/webhook/firstring-twilio-sms`;
  if (!verifyTwilio(ctx, url, req.body ?? {}, lower(req.headers)["x-twilio-signature"])) return xml(twiml(), 403);
  const cfg = clientByNumber(ctx, req.body.To);
  if (!cfg) return xml(twiml());
  return xml(await handleInboundSms(ctx, cfg, req.body));
}

export async function handleTwilioVoiceFallback(ctx, req) {
  const step = req.query.step === "status" ? "status" : "start";
  const path = `${ctx.env.FIRSTRING_WEBHOOK_BASE}/webhook/firstring-twilio-voice`;
  const url = step === "status" ? `${path}?step=status` : path;
  if (!verifyTwilio(ctx, url, req.body ?? {}, lower(req.headers)["x-twilio-signature"])) return xml(twiml(), 403);
  const cfg = clientByNumber(ctx, req.body.To ?? req.body.Called);
  if (!cfg) return xml(twiml("<Reject/>"));
  return xml(await handleVoiceFallback(ctx, cfg, step, req.body, `${path}?step=status`));
}

/** Error workflow: alert Nion. Never includes payloads, only where and what. */
export async function handleError(ctx, info) {
  const text = `FirstRing ERROR in ${info.workflow ?? "?"} / ${info.node ?? "?"}: ${String(info.message ?? "").replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]").slice(0, 300)}`;
  if (ctx.env.FIRSTRING_OPS_SHEET_ID) {
    const now = ctx.now().toISOString();
    await google(ctx).sheets.append(ctx.env.FIRSTRING_OPS_SHEET_ID, "errors", [[now, info.workflow ?? "", info.node ?? "", text, info.executionId ?? ""]]);
  }
  if (ctx.env.NION_ALERT_PHONE && ctx.env.FIRSTRING_OPS_SMS_FROM) await sendSms(ctx, ctx.env.FIRSTRING_OPS_SMS_FROM, ctx.env.NION_ALERT_PHONE, text);
  return { logged: true };
}

function clientByNumber(ctx, to) {
  const n = nanp(to);
  return Object.values(ctx.clients).find((c) => c.phone.twilio_number === n);
}

function lower(h = {}) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}
