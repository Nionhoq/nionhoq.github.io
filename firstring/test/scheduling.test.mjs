import { test } from "node:test";
import assert from "node:assert/strict";
import { findSlots, parseSlotId, withinHours } from "../lib/scheduling.mjs";
import { localToUtc, speakable } from "../lib/time.mjs";
import { example, MON_10AM } from "./helpers.mjs";

const cfg = example();
const ev = (s, e, extra = {}) => ({ id: extra.id ?? s, start: new Date(s), end: new Date(e), allDay: false, isJob: true, ...extra });

test("localToUtc handles EDT and EST across the 1 Nov 2026 change", () => {
  assert.equal(localToUtc("2026-10-31", "09:00", "America/Toronto").toISOString(), "2026-10-31T13:00:00.000Z");
  assert.equal(localToUtc("2026-11-02", "09:00", "America/Toronto").toISOString(), "2026-11-02T14:00:00.000Z");
});

test("respects minimum notice and opening hours", () => {
  const s = findSlots(cfg, [], { service: "oil_change", now: MON_10AM });
  assert.equal(s[0].start.toISOString(), localToUtc("2026-10-12", "12:00", cfg.timezone).toISOString()); // 10:00 + 2h notice
  for (const x of s) assert.ok(withinHours(cfg, x.start, x.end));
});

test("first available Tuesday, morning only", () => {
  const s = findSlots(cfg, [], { service: "oil_change", earliestDate: "2026-10-13", timeOfDay: "morning", now: MON_10AM });
  assert.equal(speakable(s[0].start, cfg.timezone), "Tuesday, October 13 at 8 AM");
  assert.ok(s.every((x) => x.start < localToUtc("2026-10-13", "12:00", cfg.timezone)));
});

test("skips busy times, honours mobile travel buffer", () => {
  const busy = [ev("2026-10-13T12:00:00Z", "2026-10-13T13:00:00Z")]; // 8:00–9:00 local
  const plain = findSlots(cfg, busy, { service: "oil_change", earliestDate: "2026-10-13", now: MON_10AM, limit: 1 });
  assert.equal(plain[0].start.toISOString(), "2026-10-13T13:00:00.000Z"); // 9:00
  const mobile = findSlots(cfg, busy, { service: "mobile_tire_swap", earliestDate: "2026-10-13", now: MON_10AM, limit: 1 });
  assert.equal(mobile[0].start.toISOString(), "2026-10-13T13:30:00.000Z"); // 9:30 — 30 min travel after the 9:00 end
});

test("max jobs per day closes the day; all-day event blocks it; closed dates skipped", () => {
  const full = Array.from({ length: 8 }, (_, i) => ev(`2026-10-13T${String(12 + i).padStart(2, "0")}:00:00Z`, `2026-10-13T${String(12 + i).padStart(2, "0")}:15:00Z`, { id: `j${i}` }));
  const s = findSlots(cfg, full, { service: "oil_change", earliestDate: "2026-10-13", now: MON_10AM, limit: 1 });
  assert.equal(s[0].start.toISOString().slice(0, 10), "2026-10-14");
  const vac = [{ id: "v", start: localToUtc("2026-10-13", "00:00", cfg.timezone), end: localToUtc("2026-10-14", "00:00", cfg.timezone), allDay: true, isJob: false }];
  assert.equal(findSlots(cfg, vac, { service: "oil_change", earliestDate: "2026-10-13", now: MON_10AM, limit: 1 })[0].start.toISOString().slice(0, 10), "2026-10-14");
  const xmas = findSlots(cfg, [], { service: "oil_change", earliestDate: "2026-12-24", now: new Date("2026-12-20T15:00:00Z"), limit: 3 });
  assert.ok(xmas.every((x) => !["2026-12-25", "2026-12-26"].includes(x.start.toISOString().slice(0, 10))));
});

test("Sunday closed, Saturday short hours, offers spread ≥ 60 min", () => {
  const s = findSlots(cfg, [], { service: "tire_swap", earliestDate: "2026-10-17", now: MON_10AM, limit: 6 });
  assert.equal(s[0].spoken, "Saturday, October 17 at 9 AM");
  assert.ok(s.every((x) => !x.spoken.startsWith("Sunday")));
  for (let i = 1; i < s.length; i++) if (s[i].start.toDateString() === s[i - 1].start.toDateString()) assert.ok(s[i].start - s[i - 1].start >= 3_600_000);
});

test("slot ids round-trip and reject junk", () => {
  const [s] = findSlots(cfg, [], { service: "oil_change", now: MON_10AM, limit: 1 });
  assert.deepEqual(parseSlotId(s.slotId), { service: "oil_change", start: s.start });
  assert.equal(parseSlotId("oil_change@tomorrow"), null);
  assert.throws(() => findSlots(cfg, [], { service: "nope", now: MON_10AM }));
});
