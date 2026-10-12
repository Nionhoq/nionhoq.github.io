// Time-zone helpers built on Intl only (no deps, so the bundle runs inside n8n).

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Wall-clock parts of `date` in `tz`. */
export function zonedParts(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    dayKey: p.weekday.toLowerCase().slice(0, 3),
  };
}

function offsetMs(utcMs, tz) {
  const p = zonedParts(new Date(utcMs), tz);
  const [y, m, d] = p.date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, new Date(utcMs).getUTCSeconds());
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Local wall time (YYYY-MM-DD, HH:MM) in `tz` → Date. DST-safe (re-checks the offset at the result). */
export function localToUtc(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm === "24:00" ? [24, 0] : hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(ts, tz);
  if (second !== ts) ts = second;
  return new Date(ts);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function dayKeyOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "Tuesday, October 13 at 9 AM" — phrased for TTS. */
export function speakable(date, tz) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(date);
  const p = zonedParts(date, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  const time = p.minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(p.minute).padStart(2, "0")} ${ampm}`;
  return `${day} at ${time}`;
}

/** Short form for SMS: "Tue Oct 13, 9:00 AM". */
export function shortWhen(date, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date).replace(/\./g, "");
}

export const WEEKDAYS = { sunday: "sun", monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri", saturday: "sat" };
