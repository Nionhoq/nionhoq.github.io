// Call lifecycle: end-of-call logging + owner summary, missed-call text-back,
// inbound SMS (owner approvals or AI conversation), and the carrier-fallback path.
import { google } from "./google.mjs";
import { sendSms, nanp, twiml, xmlEscape } from "./twilio.mjs";
import { logCall, logSms, logAction, rowsOf } from "./log.mjs";
import { FEATURES, runTool, toolNames, ownerCommand } from "./tools.mjs";
import { chat } from "./llm.mjs";
import { zonedParts } from "./time.mjs";
import { smsSystemPrompt, TOOL_SCHEMAS } from "./prompt.mjs";

const HOUR = 3_600_000;

export async function handleEndOfCall(ctx, cfg, msg) {
  const g = google(ctx);
  const call = msg.call ?? {};
  const caller = nanp(call.customer?.number ?? msg.customer?.number) ?? "";
  const dur = Math.round(msg.durationSeconds ?? ((Date.parse(msg.endedAt) - Date.parse(msg.startedAt)) / 1000 || 0));
  const userSpoke = (msg.artifact?.messages ?? msg.messages ?? []).some((m) => m.role === "user" && String(m.message ?? m.content ?? "").trim());
  const outcome = msg.analysis?.structuredData?.outcome ?? (userSpoke ? "conversation" : "no_conversation");
  const summary = msg.analysis?.summary ?? "";

  await logCall(ctx, g, cfg, [call.id ?? "", caller, dur, outcome, summary, msg.endedReason ?? ""]);
  await checkMinutesCap(ctx, g, cfg, dur);

  // Hung up on the greeting (or the call failed before anyone spoke): treat as a missed call.
  if (!userSpoke && dur < 15) {
    await textBack(ctx, g, cfg, caller, "hung_up_early");
    return;
  }
  if (caller === cfg.phone.owner_mobile) return; // owner testing the line
  const mins = Math.max(1, Math.round(dur / 60));
  await sendSms(ctx, cfg.phone.twilio_number, cfg.phone.owner_mobile,
    `FirstRing · ${cfg.name}: call from ${caller || "unknown"} (${mins} min). ${summary || "No summary."}`.slice(0, 600));
}

/** Text a caller we didn't get to talk to. CASL: only people who called us; identify the shop; STOP works. */
export async function textBack(ctx, g, cfg, phone, reason) {
  if (!FEATURES[cfg.tier].textback || !phone) return { skipped: "not_eligible" };
  const own = new Set([cfg.phone.twilio_number, cfg.phone.owner_mobile, ...(cfg.phone.shop_numbers ?? [])]);
  // Forwarded calls sometimes arrive with the shop's own number as caller ID — never text ourselves.
  if (own.has(phone)) return { skipped: "own_number" };
  const sms = rowsOf(await g.sheets.read(cfg.google.sheet_id, "sms")).filter((r) => r.phone === phone);
  if (sms.some((r) => r.direction === "optout")) return { skipped: "opted_out" };
  const since = ctx.now().getTime() - 24 * HOUR;
  if (sms.some((r) => r.direction === "textback" && Date.parse(r.at_utc) > since)) return { skipped: "recent" };
  const body = `Hi, it's ${cfg.name}. Sorry we missed your call — what can we help with? Reply here to book or ask a question. Reply STOP to opt out.`;
  const res = await sendSms(ctx, cfg.phone.twilio_number, phone, body);
  if (res.optedOut) {
    await logSms(ctx, g, cfg, phone, "optout", "twilio 21610");
    return { skipped: "opted_out" };
  }
  await logSms(ctx, g, cfg, phone, "textback", body);
  await logAction(ctx, g, cfg, "textback", phone, reason);
  return { sent: true };
}

const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|arret|arrêt)\s*$/i;

/** Twilio inbound SMS → TwiML string. */
export async function handleInboundSms(ctx, cfg, params) {
  const g = google(ctx);
  const from = nanp(params.From);
  const body = String(params.Body ?? "").trim();
  if (!from) return twiml();

  if (from === cfg.phone.owner_mobile) {
    const reply = await ownerCommand(ctx, cfg, body);
    return twiml(`<Message>${xmlEscape(reply)}</Message>`);
  }
  await logSms(ctx, g, cfg, from, STOP.test(body) ? "optout" : "in", body);
  if (STOP.test(body)) return twiml(); // Twilio sends the carrier-required STOP confirmation itself
  if (!FEATURES[cfg.tier].textback) {
    await sendSms(ctx, cfg.phone.twilio_number, cfg.phone.owner_mobile, `FirstRing · ${cfg.name}: text from ${from}: ${body}`.slice(0, 600));
    return twiml();
  }

  let reply;
  try {
    reply = await smsAgent(ctx, g, cfg, from, body);
  } catch (e) {
    await sendSms(ctx, cfg.phone.twilio_number, cfg.phone.owner_mobile, `FirstRing · ${cfg.name}: text from ${from} needs you (AI unavailable): ${body}`.slice(0, 600));
    reply = "Thanks — the team will get back to you shortly.";
  }
  await sendSms(ctx, cfg.phone.twilio_number, from, reply);
  await logSms(ctx, g, cfg, from, "out", reply);
  return twiml();
}

async function smsAgent(ctx, g, cfg, from, body) {
  const history = rowsOf(await g.sheets.read(cfg.google.sheet_id, "sms"))
    .filter((r) => r.phone === from && ["in", "out", "textback"].includes(r.direction))
    .slice(-12, -1) // the message we just logged is passed separately below
    .map((r) => ({ role: r.direction === "in" ? "user" : "assistant", content: r.body }));
  const tools = TOOL_SCHEMAS.filter((t) => toolNames(cfg).includes(t.function.name)).map((t) => ({ type: "function", function: t.function }));
  const messages = [{ role: "system", content: smsSystemPrompt(cfg, ctx.now()) }, ...history, { role: "user", content: body }];
  for (let round = 0; round < 4; round++) {
    const m = await chat(ctx, messages, tools);
    if (!m.tool_calls?.length) return String(m.content ?? "").slice(0, 600) || "Thanks — the team will get back to you shortly.";
    messages.push(m);
    for (const tc of m.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* model sent bad JSON */ }
      const result = await runTool(ctx, cfg, tc.function.name, args, { phone: from, channel: "sms" });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
  return "Thanks — I've passed this to the team and they'll follow up shortly.";
}

/**
 * Carrier fallback (Twilio number's "primary handler fails" URL), used only when Vapi is unreachable.
 * step=start → ring the owner; step=status → if nobody answered, apologise and text back.
 */
export async function handleVoiceFallback(ctx, cfg, step, params, actionUrl) {
  if (step === "start") {
    return twiml(`<Dial timeout="20" action="${xmlEscape(actionUrl)}">${xmlEscape(cfg.phone.owner_mobile)}</Dial>`);
  }
  const status = params.DialCallStatus;
  if (status === "completed" || status === "answered") return twiml("<Hangup/>");
  const g = google(ctx);
  const from = nanp(params.From);
  await textBack(ctx, g, cfg, from, `fallback_${status ?? "unknown"}`);
  return twiml(`<Say voice="Polly.Joanna">Sorry we missed you. We'll text you right away.</Say><Hangup/>`);
}

/** Alert Nion as a client crosses 80% and 100% of their included minutes this month. */
async function checkMinutesCap(ctx, g, cfg, addedSeconds) {
  if (!cfg.minutes_cap) return;
  const month = zonedParts(ctx.now(), cfg.timezone).date.slice(0, 7);
  const secs = rowsOf(await g.sheets.read(cfg.google.sheet_id, "calls"))
    .filter((r) => r.local_time.startsWith(month)).reduce((s, r) => s + Number(r.duration_s || 0), 0);
  const before = (secs - addedSeconds) / 60;
  const after = secs / 60;
  for (const pct of [0.8, 1]) {
    const line = cfg.minutes_cap * pct;
    if (before < line && after >= line && ctx.env.NION_ALERT_PHONE) {
      await sendSms(ctx, cfg.phone.twilio_number, ctx.env.NION_ALERT_PHONE,
        `FirstRing ops: ${cfg.name} hit ${Math.round(pct * 100)}% of ${cfg.minutes_cap} included minutes (${Math.round(after)} min) for ${month}.`);
    }
  }
}
