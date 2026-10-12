// The client's Google Sheet is the operational log. Tabs and columns are fixed here so
// provisioning, logging, the daily summary and the purge all agree.
import { zonedParts } from "./time.mjs";

export const TABS = {
  calls: ["at_utc", "local_time", "call_id", "caller", "duration_s", "outcome", "summary", "ended_reason"],
  actions: ["at_utc", "local_time", "kind", "phone", "detail", "event_id"],
  sms: ["at_utc", "local_time", "phone", "direction", "body"],
};

const stamp = (ctx, cfg) => {
  const now = ctx.now();
  const p = zonedParts(now, cfg.timezone);
  return [now.toISOString(), `${p.date} ${p.time}`];
};

export const logAction = (ctx, g, cfg, kind, phone, detail, eventId = "") =>
  g.sheets.append(cfg.google.sheet_id, "actions", [[...stamp(ctx, cfg), kind, phone ?? "", detail, eventId]]);

export const logSms = (ctx, g, cfg, phone, direction, body) =>
  g.sheets.append(cfg.google.sheet_id, "sms", [[...stamp(ctx, cfg), phone, direction, body]]);

export const logCall = (ctx, g, cfg, row) =>
  g.sheets.append(cfg.google.sheet_id, "calls", [[...stamp(ctx, cfg), ...row]]);

/** Sheet rows → objects keyed by header. */
export function rowsOf(values) {
  const [head, ...rows] = values;
  if (!head) return [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
