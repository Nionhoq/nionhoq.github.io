// Slot finding: opening hours, closed dates, service duration, travel buffers,
// minimum notice, max jobs/day, and existing calendar events. Pure function.
import { localToUtc, addDays, dayKeyOf, zonedParts, speakable } from "./time.mjs";

const MIN = 60_000;
const TOD = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24], any: [0, 24] };

/**
 * @param {object} cfg client config
 * @param {Array<{start:Date,end:Date,allDay?:boolean,isJob?:boolean,id?:string}>} busy existing events
 * @param {{ service: string, earliestDate?: string, timeOfDay?: string, now: Date, limit?: number, ignoreEventId?: string }} q
 * @returns {Array<{ slotId: string, start: Date, end: Date, spoken: string }>}
 */
export function findSlots(cfg, busy, q) {
  const svc = cfg.services.find((s) => s.key === q.service);
  if (!svc) throw new Error(`unknown service ${q.service}`);
  const tz = cfg.timezone;
  const b = cfg.booking;
  const step = b.slot_minutes * MIN;
  const dur = svc.duration_min * MIN;
  const buf = (svc.buffer_min ?? 0) * MIN;
  const earliestStart = new Date(q.now.getTime() + b.min_notice_minutes * MIN);
  const today = zonedParts(q.now, tz).date;
  const startDay = q.earliestDate && q.earliestDate > today ? q.earliestDate : today;
  const [todFrom, todTo] = TOD[q.timeOfDay ?? "any"] ?? TOD.any;
  const events = busy.filter((e) => e.id !== q.ignoreEventId);
  const limit = q.limit ?? 3;
  const out = [];

  for (let i = 0; i <= b.horizon_days && out.length < limit; i++) {
    const day = addDays(startDay, i);
    if (day > addDays(today, b.horizon_days)) break;
    if ((cfg.closed_dates ?? []).includes(day)) continue;
    const ranges = cfg.hours[dayKeyOf(day)] ?? [];
    if (!ranges.length) continue;

    const dayStart = localToUtc(day, "00:00", tz);
    const dayEnd = localToUtc(addDays(day, 1), "00:00", tz);
    const sameDay = events.filter((e) => e.start < dayEnd && e.end > dayStart);
    if (sameDay.some((e) => e.allDay)) continue; // owner blocked the whole day
    const jobsToday = sameDay.filter((e) => e.isJob).length;
    if (jobsToday >= b.max_jobs_per_day) continue;

    let lastPicked = null;
    for (const [open, close] of ranges) {
      const rStart = localToUtc(day, open, tz).getTime();
      const rEnd = localToUtc(day, close, tz).getTime();
      for (let t = rStart; t + dur <= rEnd && out.length < limit; t += step) {
        if (t < earliestStart.getTime()) continue;
        const hour = zonedParts(new Date(t), tz).hour;
        if (hour < todFrom || hour >= todTo) continue;
        const s = t - buf;
        const e = t + dur + buf;
        if (sameDay.some((ev) => !ev.allDay && ev.start.getTime() < e && ev.end.getTime() > s)) continue;
        // Spread offers: at least 60 min apart on the same day.
        if (lastPicked !== null && t - lastPicked < 60 * MIN) continue;
        lastPicked = t;
        const start = new Date(t);
        out.push({ slotId: makeSlotId(svc.key, start), start, end: new Date(t + dur), spoken: speakable(start, tz) });
      }
    }
  }
  return out;
}

export function makeSlotId(service, start) {
  return `${service}@${start.toISOString()}`;
}

export function parseSlotId(slotId) {
  const m = /^([a-z0-9_]+)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(String(slotId ?? ""));
  if (!m) return null;
  return { service: m[1], start: new Date(m[2]) };
}

/** True when [start,end] (plus buffer) collides with any event except `ignoreId`. */
export function collides(busy, start, end, bufferMin = 0, ignoreId) {
  const s = start.getTime() - bufferMin * MIN;
  const e = end.getTime() + bufferMin * MIN;
  return busy.some((ev) => ev.id !== ignoreId && (ev.allDay ? ev.start.getTime() < e && ev.end.getTime() > s : ev.start.getTime() < e && ev.end.getTime() > s));
}

/** Is `start` inside opening hours (and not closed) for the whole job? */
export function withinHours(cfg, start, end) {
  const tz = cfg.timezone;
  const p = zonedParts(start, tz);
  if ((cfg.closed_dates ?? []).includes(p.date)) return false;
  return (cfg.hours[p.dayKey] ?? []).some(([o, c]) =>
    start >= localToUtc(p.date, o, tz) && end <= localToUtc(p.date, c, tz));
}
