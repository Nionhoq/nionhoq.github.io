// Prompts and tool schemas, generated from the client config (the knowledge base).
import { zonedParts } from "./time.mjs";

const DAYS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];

function hoursText(cfg) {
  return DAYS.map(([k, n]) => `${n}: ${(cfg.hours[k] ?? []).map(([a, b]) => `${a}–${b}`).join(", ") || "closed"}`).join("; ");
}

export function knowledgeBase(cfg) {
  const svc = cfg.services.map((s) =>
    `- ${s.name} (key ${s.key}): ${s.price}${s.price_note ? ` (${s.price_note})` : ""}, about ${s.duration_min} min${s.mobile ? ", mobile service at the customer's address" : ""}`).join("\n");
  const faqs = (cfg.faqs ?? []).map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n");
  const pol = Object.entries(cfg.policies ?? {}).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return [
    `BUSINESS: ${cfg.name}, ${cfg.address ?? ""}`.trim(),
    `HOURS: ${hoursText(cfg)}${(cfg.closed_dates ?? []).length ? `. Closed on: ${cfg.closed_dates.join(", ")}` : ""}`,
    `SERVICE AREA: ${(cfg.service_area ?? []).join(", ") || "at the shop"}`,
    `SERVICES AND PRICES (quote only these, exactly as written):\n${svc}`,
    faqs && `FAQS:\n${faqs}`,
    pol && `POLICIES:\n${pol}`,
  ].filter(Boolean).join("\n\n");
}

function rules(cfg) {
  const booking = cfg.tier !== "essential";
  return [
    "RULES (never break these):",
    "- You are an automated assistant. If asked whether you are a person, say so plainly.",
    `- Only quote prices listed above. For anything else (diagnosis, parts, body work) say the owner will give a quote after seeing the vehicle — never estimate.`,
    `- ALWAYS escalate_to_owner, never handle yourself, and book nothing in the same conversation: ${cfg.escalation.join(", ")}. Empathise first, then escalate.`,
    "- If you're unsure, the request is unusual, or the caller asks for the owner: take_message. Never argue and never invent information.",
    booking && "- Booking: confirm service, then call check_availability. Offer the times it returns. Ask the caller's name and vehicle (year/make/model); for mobile services, ask the address. Then call book_appointment with the slot id the caller chose.",
    booking && "- Never read slot ids or booking ids aloud. Never claim a booking is confirmed unless book_appointment said so.",
    booking && "- To reschedule or cancel: call find_booking first (it searches by the caller's phone number), then reschedule_booking or cancel_booking.",
    booking && cfg.booking.shadow_mode && "- New bookings are requests the shop confirms by text. Say that, don't promise a confirmed time.",
    !booking && "- You cannot book appointments on this line. Take a message with the caller's name, vehicle and what they need; the owner will call back to book.",
    "- Emergencies (accident, smoke, someone hurt): tell them to call 9-1-1, then escalate_to_owner.",
  ].filter(Boolean).join("\n");
}

export function voiceSystemPrompt(cfg) {
  return [
    `You answer the phone for ${cfg.name}, an auto service business in the Greater Toronto Area. Today's date and time are provided as {{"now" | date: "%A, %B %d, %Y %I:%M %p", "${cfg.timezone}"}}.`,
    "STYLE: friendly and brief. One question at a time. Say prices and times naturally. No lists, no URLs.",
    rules(cfg),
    knowledgeBase(cfg),
  ].join("\n\n");
}

export function smsSystemPrompt(cfg, now) {
  const p = zonedParts(now, cfg.timezone);
  return [
    `You are texting on behalf of ${cfg.name}. Today is ${p.date} (${p.dayKey}), local time ${p.time} (${cfg.timezone}).`,
    "STYLE: SMS. Short (under 300 characters), plain text, no emojis spam, no markdown. You may list up to three times on one line.",
    rules(cfg),
    knowledgeBase(cfg),
  ].join("\n\n");
}

export function greeting(cfg) {
  return cfg.recording
    ? `Hi, you've reached ${cfg.name}. I'm the automated assistant, and this call may be recorded for quality. How can I help?`
    : `Hi, you've reached ${cfg.name}. I'm the automated assistant. How can I help?`;
}

/** One schema per tool, used for both Vapi (voice) and OpenAI (SMS). */
export const TOOL_SCHEMAS = [
  {
    filler: "One sec, let me check the schedule.",
    function: {
      name: "check_availability",
      description: "Find open appointment times for a service. Call before offering any time.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service key or name from the services list." },
          earliest_date: { type: "string", description: "YYYY-MM-DD; resolve 'tomorrow', 'next week' from today's date." },
          day_of_week: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], description: "Use when the caller names a weekday, e.g. 'first available Tuesday'." },
          time_of_day: { type: "string", enum: ["morning", "afternoon", "evening", "any"] },
        },
        required: ["service"],
      },
    },
  },
  {
    filler: "Booking that now.",
    function: {
      name: "book_appointment",
      description: "Book a slot returned by check_availability, after the caller picked it and gave their name.",
      parameters: {
        type: "object",
        properties: {
          slot_id: { type: "string", description: "Exact slot id from check_availability." },
          customer_name: { type: "string" },
          vehicle: { type: "string", description: "Year, make, model." },
          address: { type: "string", description: "Required for mobile services." },
          notes: { type: "string", maxLength: 200 },
        },
        required: ["slot_id", "customer_name"],
      },
    },
  },
  {
    filler: "Let me look that up.",
    function: { name: "find_booking", description: "Find the caller's upcoming bookings (matched by the phone number they are calling or texting from).", parameters: { type: "object", properties: {} } },
  },
  {
    filler: "Moving that for you.",
    function: {
      name: "reschedule_booking",
      description: "Move a booking found by find_booking to a new slot from check_availability.",
      parameters: { type: "object", properties: { booking_id: { type: "string" }, slot_id: { type: "string" } }, required: ["booking_id", "slot_id"] },
    },
  },
  {
    filler: "Okay, cancelling that.",
    function: {
      name: "cancel_booking",
      description: "Cancel a booking found by find_booking, after the caller confirms.",
      parameters: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
    },
  },
  {
    function: {
      name: "escalate_to_owner",
      description: "Immediately alert the owner about a complaint, damage claim, price dispute, or emergency. Books nothing.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["complaint", "damage_claim", "price_dispute", "emergency", "other"] },
          summary: { type: "string", description: "What happened, in the caller's words, one or two sentences." },
          customer_name: { type: "string" },
        },
        required: ["category", "summary"],
      },
    },
  },
  {
    function: {
      name: "take_message",
      description: "Pass a message to the owner for a callback (unsure, unusual request, quote needed, caller asks for the owner).",
      parameters: { type: "object", properties: { summary: { type: "string" }, customer_name: { type: "string" } }, required: ["summary"] },
    },
  },
];
