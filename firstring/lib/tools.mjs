// Tool handlers shared by the voice agent (Vapi tool calls) and the SMS agent.
// Every handler returns a short string the model can say or text as-is.
// The customer's phone number always comes from the carrier (meta.phone), never from the model.
import { findSlots, parseSlotId, collides, withinHours } from "./scheduling.mjs";
import { google, toBusy } from "./google.mjs";
import { sendSms } from "./twilio.mjs";
import { zonedParts, addDays, shortWhen, speakable, WEEKDAYS, localToUtc } from "./time.mjs";
import { logAction } from "./log.mjs";

const DAY = 86_400_000;

export const FEATURES = {
  essential: { booking: false, textback: false },
  pro: { booking: true, textback: true },
  complete: { booking: true, textback: true },
};

export function toolNames(cfg) {
  const base = ["escalate_to_owner", "take_message"];
  return FEATURES[cfg.tier].booking
    ? ["check_availability", "book_appointment", "find_booking", "reschedule_booking", "cancel_booking", ...base]
    : base;
}

export async function runTool(ctx, cfg, name, args, meta) {
  if (!toolNames(cfg).includes(name)) return "That's not something I can do on this line. I'll take a message for the owner instead.";
  const g = google(ctx);
  const h = { check_availability, book_appointment, find_booking, reschedule_booking, cancel_booking, escalate_to_owner, take_message }[name];
  return h(ctx, g, cfg, args ?? {}, meta);
}

// ---------------------------------------------------------------------------
function resolveService(cfg, raw) {
  const q = String(raw ?? "").toLowerCase().trim();
  return cfg.services.find((s) => s.key === q)
    ?? cfg.services.find((s) => s.name.toLowerCase() === q)
    ?? cfg.services.find((s) => q && (s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())));
}

function nextWeekday(cfg, now, dayName) {
  const key = WEEKDAYS[String(dayName ?? "").toLowerCase()];
  if (!key) return null;
  let d = zonedParts(now, cfg.timezone).date;
  for (let i = 0; i < 7; i++, d = addDays(d, 1)) if (zonedParts(localToUtc(d, "12:00", cfg.timezone), cfg.timezone).dayKey === key) return d;
  return null;
}

async function busyBetween(g, cfg, from, to) {
  const items = await g.calendar.list(cfg.google.calendar_id, from, to);
  return items.map((e) => toBusy(e, cfg.timezone)).filter(Boolean);
}

const svcList = (cfg) => cfg.services.map((s) => s.name).join(", ");
const ownerSms = (ctx, cfg, body) => sendSms(ctx, cfg.phone.twilio_number, cfg.phone.owner_mobile, `FirstRing · ${cfg.name}: ${body}`);
const customerSms = (ctx, cfg, to, body) => (to ? sendSms(ctx, cfg.phone.twilio_number, to, `${cfg.name}: ${body}`) : null);
const offerText = (slots) =>
  `${slots.map((s) => s.spoken).join(", or ")}. Which works best? [slot ids for booking, do not read aloud: ${slots.map((s) => s.slotId).join(" ")}]`;

// ---------------------------------------------------------------------------
async function check_availability(ctx, g, cfg, a) {
  const svc = resolveService(cfg, a.service);
  if (!svc) return `Which service do you need? We offer ${svcList(cfg)}.`;
  const now = ctx.now();
  const earliestDate = /^\d{4}-\d{2}-\d{2}$/.test(a.earliest_date ?? "") ? a.earliest_date : nextWeekday(cfg, now, a.day_of_week) ?? undefined;
  const busy = await busyBetween(g, cfg, now, new Date(now.getTime() + (cfg.booking.horizon_days + 2) * DAY));
  const slots = findSlots(cfg, busy, { service: svc.key, earliestDate, timeOfDay: a.time_of_day, now });
  if (!slots.length) {
    return `I don't see an opening for ${svc.name.toLowerCase()} in the next ${cfg.booking.horizon_days} days with those preferences. I can take a message so the owner can fit you in.`;
  }
  return `For ${svc.name.toLowerCase()} (about ${svc.duration_min} minutes), I have ${offerText(slots)}`;
}

async function book_appointment(ctx, g, cfg, a, meta) {
  const slot = parseSlotId(a.slot_id);
  const svc = slot && cfg.services.find((s) => s.key === slot.service);
  if (!slot || !svc) return "I need to check availability first so I can offer you a real time.";
  if (!a.customer_name) return "Can I get your name for the booking?";
  if (svc.mobile && !a.address) return "This is a mobile service, so I need the address where the vehicle will be.";
  const now = ctx.now();
  const end = new Date(slot.start.getTime() + svc.duration_min * 60_000);
  if (slot.start.getTime() < now.getTime() + cfg.booking.min_notice_minutes * 60_000 || !withinHours(cfg, slot.start, end)) {
    return "That time isn't available anymore. Let me check the next openings for you.";
  }

  const dayStart = localToUtc(zonedParts(slot.start, cfg.timezone).date, "00:00", cfg.timezone);
  const busy = await busyBetween(g, cfg, dayStart, new Date(dayStart.getTime() + DAY));
  const jobsThatDay = busy.filter((e) => e.isJob).length;
  if (collides(busy, slot.start, end, svc.buffer_min ?? 0) || jobsThatDay >= cfg.booking.max_jobs_per_day || busy.some((e) => e.allDay)) {
    return conflictReply(ctx, g, cfg, svc, now);
  }

  const pending = cfg.booking.shadow_mode;
  const code = pending ? String(1000 + Math.floor(Math.random() * 9000)) : "";
  const phone = meta.phone ?? "";
  const ev = await g.calendar.insert(cfg.google.calendar_id, eventBody(cfg, svc, slot.start, end, a, phone, meta, { pending, code, action: "book" }));

  // Post-write check: two callers can pass the pre-check at the same moment. The earlier insert wins.
  if (await lostRace(g, cfg, ev, svc)) {
    await g.calendar.remove(cfg.google.calendar_id, ev.id);
    return conflictReply(ctx, g, cfg, svc, now);
  }

  const when = shortWhen(slot.start, cfg.timezone);
  const who = `${a.customer_name}${phone ? ` (${phone})` : ""}`;
  const extra = [a.vehicle, a.address].filter(Boolean).join(", ");
  if (pending) {
    await ownerSms(ctx, cfg, `Booking request — ${svc.name}, ${when}, ${who}${extra ? `, ${extra}` : ""}. Reply YES ${code} to confirm or NO ${code} to decline.`);
    await logAction(ctx, g, cfg, "booking_requested", phone, `${svc.name} ${when} ${a.customer_name}`, ev.id);
    return `I've put in a request for ${speakable(slot.start, cfg.timezone)} for your ${svc.name.toLowerCase()}. The shop will confirm by text shortly.`;
  }
  await ownerSms(ctx, cfg, `New booking: ${svc.name}, ${when}, ${who}${extra ? `, ${extra}` : ""}.`);
  await customerSms(ctx, cfg, phone, `You're booked for ${svc.name} on ${when}. Reply here or call us to change it.`);
  await logAction(ctx, g, cfg, "booking", phone, `${svc.name} ${when} ${a.customer_name}`, ev.id);
  return `You're all set for ${speakable(slot.start, cfg.timezone)}${phone ? ". I've texted you a confirmation" : ""}.`;
}

async function conflictReply(ctx, g, cfg, svc, now) {
  const busy = await busyBetween(g, cfg, now, new Date(now.getTime() + (cfg.booking.horizon_days + 2) * DAY));
  const slots = findSlots(cfg, busy, { service: svc.key, now });
  return slots.length
    ? `Sorry, that time was just taken. The next openings are ${offerText(slots)}`
    : "Sorry, that time was just taken and I don't see other openings soon. I'll have the owner call you.";
}

async function lostRace(g, cfg, ours, svc) {
  const s = new Date(new Date(ours.start.dateTime).getTime() - (svc.buffer_min ?? 0) * 60_000);
  const e = new Date(new Date(ours.end.dateTime).getTime() + (svc.buffer_min ?? 0) * 60_000);
  const others = (await g.calendar.list(cfg.google.calendar_id, s, e))
    .filter((x) => x.id !== ours.id && x.status !== "cancelled" && x.transparency !== "transparent");
  return others.some((x) => !x.start?.dateTime || (x.created ?? "") < (ours.created ?? "") || ((x.created ?? "") === (ours.created ?? "") && x.id < ours.id));
}

function eventBody(cfg, svc, start, end, a, phone, meta, { pending, code, action, replaces }) {
  return {
    summary: `${pending ? "[PENDING] " : ""}${svc.name} — ${a.customer_name}`,
    description: [
      `Customer: ${a.customer_name}`, phone && `Phone: ${phone}`, a.vehicle && `Vehicle: ${a.vehicle}`,
      a.address && `Address: ${a.address}`, a.notes && `Notes: ${a.notes}`,
      `Booked by FirstRing (${meta.channel}${meta.callId ? ` ${meta.callId}` : ""})`,
      pending && `Awaiting owner approval — reply YES ${code} / NO ${code} to the FirstRing text.`,
    ].filter(Boolean).join("\n"),
    start: { dateTime: start.toISOString(), timeZone: cfg.timezone },
    end: { dateTime: end.toISOString(), timeZone: cfg.timezone },
    status: pending ? "tentative" : "confirmed",
    extendedProperties: {
      private: {
        fr: "1", fr_client: cfg.id, fr_service: svc.key, fr_phone: phone, fr_name: a.customer_name,
        fr_status: pending ? "pending" : "confirmed", fr_code: code, fr_action: action, fr_replaces: replaces ?? "",
      },
    },
  };
}

async function upcomingFor(g, cfg, phone, now) {
  if (!phone) return [];
  const items = await g.calendar.list(cfg.google.calendar_id, now, new Date(now.getTime() + 120 * DAY), { fr_phone: phone, fr_client: cfg.id });
  return items.filter((e) => e.status !== "cancelled");
}

async function find_booking(ctx, g, cfg, a, meta) {
  const list = await upcomingFor(g, cfg, meta.phone, ctx.now());
  if (!list.length) {
    return "I don't see any upcoming bookings under the number you're contacting us from. I can take a message and the owner will sort it out.";
  }
  const desc = list.map((e) => {
    const svc = cfg.services.find((s) => s.key === e.extendedProperties.private.fr_service);
    const tag = e.extendedProperties.private.fr_status === "pending" ? " (awaiting confirmation)" : "";
    return `${svc?.name ?? "appointment"} on ${speakable(new Date(e.start.dateTime), cfg.timezone)}${tag} [booking id, do not read aloud: ${e.id}]`;
  });
  return `I found: ${desc.join("; ")}.`;
}

async function ownedBooking(g, cfg, id, phone) {
  if (!id || !phone) return null;
  const ev = await g.calendar.get(cfg.google.calendar_id, id).catch(() => null);
  const p = ev?.extendedProperties?.private;
  return ev && ev.status !== "cancelled" && p?.fr_client === cfg.id && p?.fr_phone === phone ? ev : null;
}

async function reschedule_booking(ctx, g, cfg, a, meta) {
  const ev = await ownedBooking(g, cfg, a.booking_id, meta.phone);
  if (!ev) return "I couldn't find that booking under your number. I'll take a message for the owner.";
  const slot = parseSlotId(a.slot_id);
  const p = ev.extendedProperties.private;
  const svc = cfg.services.find((s) => s.key === p.fr_service);
  if (!slot || slot.service !== svc.key) return "Let me check availability for the new time first.";
  const end = new Date(slot.start.getTime() + svc.duration_min * 60_000);
  const now = ctx.now();
  if (slot.start.getTime() < now.getTime() + cfg.booking.min_notice_minutes * 60_000 || !withinHours(cfg, slot.start, end)) {
    return "That time isn't available anymore. Let me check the next openings for you.";
  }
  const dayStart = localToUtc(zonedParts(slot.start, cfg.timezone).date, "00:00", cfg.timezone);
  const busy = await busyBetween(g, cfg, dayStart, new Date(dayStart.getTime() + DAY));
  if (collides(busy, slot.start, end, svc.buffer_min ?? 0, ev.id)) return conflictReply(ctx, g, cfg, svc, now);

  const oldWhen = shortWhen(new Date(ev.start.dateTime), cfg.timezone);
  const newWhen = shortWhen(slot.start, cfg.timezone);
  const person = { customer_name: p.fr_name, vehicle: "", address: "", notes: `Rescheduled from ${oldWhen}` };
  if (cfg.booking.shadow_mode) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    const hold = await g.calendar.insert(cfg.google.calendar_id, eventBody(cfg, svc, slot.start, end, person, meta.phone, meta, { pending: true, code, action: "reschedule", replaces: ev.id }));
    if (await lostRace(g, cfg, hold, svc)) {
      await g.calendar.remove(cfg.google.calendar_id, hold.id);
      return conflictReply(ctx, g, cfg, svc, now);
    }
    await ownerSms(ctx, cfg, `Reschedule request — ${p.fr_name} (${meta.phone}) ${svc.name} from ${oldWhen} to ${newWhen}. Reply YES ${code} or NO ${code}.`);
    await logAction(ctx, g, cfg, "reschedule_requested", meta.phone, `${svc.name} ${oldWhen} → ${newWhen}`, hold.id);
    return `I've requested to move your ${svc.name.toLowerCase()} to ${speakable(slot.start, cfg.timezone)}. Your current time stays booked until the shop confirms by text.`;
  }
  await g.calendar.patch(cfg.google.calendar_id, ev.id, {
    start: { dateTime: slot.start.toISOString(), timeZone: cfg.timezone },
    end: { dateTime: end.toISOString(), timeZone: cfg.timezone },
  });
  await ownerSms(ctx, cfg, `Rescheduled: ${p.fr_name} (${meta.phone}) ${svc.name} ${oldWhen} → ${newWhen}.`);
  await customerSms(ctx, cfg, meta.phone, `Your ${svc.name} is moved to ${newWhen}.`);
  await logAction(ctx, g, cfg, "reschedule", meta.phone, `${svc.name} ${oldWhen} → ${newWhen}`, ev.id);
  return `Done. Your ${svc.name.toLowerCase()} is now ${speakable(slot.start, cfg.timezone)}, and the old time is released.`;
}

async function cancel_booking(ctx, g, cfg, a, meta) {
  const ev = await ownedBooking(g, cfg, a.booking_id, meta.phone);
  if (!ev) return "I couldn't find that booking under your number. I'll take a message for the owner.";
  const p = ev.extendedProperties.private;
  const svc = cfg.services.find((s) => s.key === p.fr_service);
  const when = shortWhen(new Date(ev.start.dateTime), cfg.timezone);
  await g.calendar.remove(cfg.google.calendar_id, ev.id);
  await ownerSms(ctx, cfg, `Cancelled: ${p.fr_name} (${meta.phone}) ${svc?.name ?? ""} ${when}. Slot is free again.`);
  await customerSms(ctx, cfg, meta.phone, `Your ${svc?.name ?? "appointment"} on ${when} is cancelled.`);
  await logAction(ctx, g, cfg, "cancel", meta.phone, `${svc?.name} ${when}`, ev.id);
  return `Your ${svc?.name.toLowerCase() ?? "appointment"} on ${speakable(new Date(ev.start.dateTime), cfg.timezone)} is cancelled. I've texted you a confirmation.`;
}

async function escalate_to_owner(ctx, g, cfg, a, meta) {
  const who = [a.customer_name, meta.phone].filter(Boolean).join(" ");
  await ownerSms(ctx, cfg, `URGENT ${String(a.category ?? "issue").toUpperCase()} — ${who || "unknown caller"}: ${a.summary ?? "(no details)"}. Please call back.`);
  await logAction(ctx, g, cfg, "escalation", meta.phone, `${a.category}: ${a.summary}`);
  return "I'm sorry about this. I've sent it straight to the owner, and they'll call you back personally.";
}

async function take_message(ctx, g, cfg, a, meta) {
  const who = [a.customer_name, meta.phone].filter(Boolean).join(" ");
  await ownerSms(ctx, cfg, `Message from ${who || "a caller"}: ${a.summary ?? ""}`);
  await logAction(ctx, g, cfg, "message", meta.phone, a.summary ?? "");
  return "Got it. I've passed that on, and the owner will get back to you.";
}

// ---------------------------------------------------------------------------
// Owner approvals (shadow mode): "YES 4821", "NO 4821", "LIST".
export async function ownerCommand(ctx, cfg, text) {
  const g = google(ctx);
  const m = /^\s*(yes|y|ok|confirm|no|n|decline|list)\b\s*(\d{4})?/i.exec(text ?? "");
  if (!m) return "FirstRing: reply YES <code> or NO <code> to a booking request, or LIST to see pending requests.";
  const verb = m[1].toLowerCase();
  const now = ctx.now();
  const pending = (await g.calendar.list(cfg.google.calendar_id, new Date(now.getTime() - DAY), new Date(now.getTime() + 120 * DAY), { fr_client: cfg.id, fr_status: "pending" }))
    .filter((e) => e.status !== "cancelled");
  if (verb === "list") {
    return pending.length
      ? `Pending: ${pending.map((e) => `${e.extendedProperties.private.fr_code} ${e.summary.replace("[PENDING] ", "")} ${shortWhen(new Date(e.start.dateTime), cfg.timezone)}`).join("; ")}`
      : "No pending requests.";
  }
  const target = m[2] ? pending.filter((e) => e.extendedProperties.private.fr_code === m[2]) : pending;
  if (target.length !== 1) return target.length ? "Several requests are pending — reply with the code, e.g. YES 4821. Send LIST to see them." : "No matching pending request.";
  const ev = target[0];
  const p = ev.extendedProperties.private;
  const svc = cfg.services.find((s) => s.key === p.fr_service);
  const when = shortWhen(new Date(ev.start.dateTime), cfg.timezone);
  const approve = ["yes", "y", "ok", "confirm"].includes(verb);

  if (approve) {
    await g.calendar.patch(cfg.google.calendar_id, ev.id, {
      summary: ev.summary.replace("[PENDING] ", ""),
      status: "confirmed",
      extendedProperties: { private: { ...p, fr_status: "confirmed", fr_code: "" } },
    });
    if (p.fr_action === "reschedule" && p.fr_replaces) await g.calendar.remove(cfg.google.calendar_id, p.fr_replaces);
    await customerSms(ctx, cfg, p.fr_phone, p.fr_action === "reschedule"
      ? `Confirmed: your ${svc?.name} is moved to ${when}.`
      : `Confirmed: you're booked for ${svc?.name} on ${when}. Reply here or call us to change it.`);
    await logAction(ctx, g, cfg, "approved", p.fr_phone, `${p.fr_action} ${svc?.name} ${when}`, ev.id);
    return `Confirmed ${p.fr_name}, ${svc?.name}, ${when}. Customer notified.`;
  }
  await g.calendar.remove(cfg.google.calendar_id, ev.id);
  await customerSms(ctx, cfg, p.fr_phone, p.fr_action === "reschedule"
    ? `Sorry, ${when} didn't work out. Your original booking stays as it was; we'll call if anything changes.`
    : `Sorry, ${when} didn't work out. We'll call you to find another time.`);
  await logAction(ctx, g, cfg, "declined", p.fr_phone, `${p.fr_action} ${svc?.name} ${when}`, ev.id);
  return `Declined ${p.fr_name}, ${when}. Customer told you'll call them.`;
}
