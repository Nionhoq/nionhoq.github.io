// Hourly job: per-client daily summary (at summary_hour local) and retention purge (03:00 local).
import { google } from "./google.mjs";
import { sendSms } from "./twilio.mjs";
import { rowsOf } from "./log.mjs";
import { zonedParts } from "./time.mjs";
import { deleteVapiCall } from "./vapi.mjs";

const DAY = 86_400_000;

export async function runHourly(ctx) {
  const done = [];
  for (const cfg of Object.values(ctx.clients)) {
    const p = zonedParts(ctx.now(), cfg.timezone);
    try {
      if (p.hour === (cfg.summary_hour ?? 18)) done.push([cfg.id, "summary", await dailySummary(ctx, cfg)]);
      if (p.hour === 3) done.push([cfg.id, "purge", await purge(ctx, cfg)]);
    } catch (e) {
      done.push([cfg.id, "error", e.message]);
      if (ctx.reportError) await ctx.reportError(e, { client: cfg.id, job: "hourly" });
    }
  }
  return done;
}

export async function dailySummary(ctx, cfg) {
  const g = google(ctx);
  const today = zonedParts(ctx.now(), cfg.timezone).date;
  const month = today.slice(0, 7);
  const [calls, actions, sms] = await Promise.all(["calls", "actions", "sms"].map(async (t) => rowsOf(await g.sheets.read(cfg.google.sheet_id, t))));
  const isToday = (r) => r.local_time.startsWith(today);
  const c = calls.filter(isToday);
  const a = actions.filter(isToday);
  const count = (k) => a.filter((r) => r.kind === k).length;
  const textbacks = sms.filter((r) => isToday(r) && r.direction === "textback").length;
  const replied = new Set(sms.filter((r) => isToday(r) && r.direction === "in").map((r) => r.phone));
  const recovered = new Set(sms.filter((r) => isToday(r) && r.direction === "textback").map((r) => r.phone).filter((x) => replied.has(x))).size;
  const pending = (await g.calendar.list(cfg.google.calendar_id, ctx.now(), new Date(ctx.now().getTime() + 120 * DAY), { fr_client: cfg.id, fr_status: "pending" })).length;
  const minutes = Math.round(calls.filter((r) => r.local_time.startsWith(month)).reduce((s, r) => s + Number(r.duration_s || 0), 0) / 60);
  const lines = [
    `FirstRing · ${cfg.name} — today:`,
    `${c.length} calls answered`,
    `${count("booking") + count("approved")} bookings${count("booking_requested") ? `, ${count("booking_requested")} requested` : ""}`,
    textbacks ? `${textbacks} missed-call texts, ${recovered} replied` : null,
    count("escalation") ? `${count("escalation")} urgent issue(s) sent to you` : null,
    count("message") ? `${count("message")} message(s) to call back` : null,
    pending ? `${pending} booking request(s) waiting for your YES/NO — text LIST` : null,
    cfg.minutes_cap ? `${minutes}/${cfg.minutes_cap} min used this month` : null,
  ].filter(Boolean);
  await sendSms(ctx, cfg.phone.twilio_number, cfg.phone.owner_mobile, lines.join("\n"));
  return lines.length;
}

/**
 * Delete log rows (and the Vapi call record) older than retention_days.
 * Rows are appended in time order, so the expired ones are a prefix.
 * Caveat: Google Sheets version history still holds deleted rows until the sheet's
 * history is cleared — which is why transcripts are never written to the sheet.
 */
export async function purge(ctx, cfg) {
  const g = google(ctx);
  const cutoff = ctx.now().getTime() - cfg.retention_days * DAY;
  const out = {};
  for (const tab of ["calls", "actions", "sms"]) {
    const rows = rowsOf(await g.sheets.read(cfg.google.sheet_id, tab));
    let n = 0;
    while (n < rows.length && Date.parse(rows[n].at_utc) < cutoff) n++;
    if (!n) continue;
    if (tab === "calls") for (const r of rows.slice(0, n)) if (r.call_id) await deleteVapiCall(ctx, r.call_id);
    await g.sheets.deleteRows(cfg.google.sheet_id, tab, 1, 1 + n);
    out[tab] = n;
  }
  return out;
}
