// End-to-end through the real entry points (handleVapi / handleTwilioSms / ...) against mock APIs.
// Includes the runbook's five-scenario sign-off script (backend side).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMocks, setupSheet, twilioSign } from "./mocks.mjs";
import { example, ctxFor, vapiHeaders, toolCall, slotIds, bookingIds, resultOf, MON_10AM } from "./helpers.mjs";
import { handleVapi, handleTwilioSms, handleTwilioVoiceFallback, runHourly } from "../lib/index.mjs";
import { voiceSystemPrompt } from "../lib/prompt.mjs";
import { localToUtc } from "../lib/time.mjs";

let mocks;
before(async () => { mocks = await startMocks(); });
after(() => mocks.close());

let cfg, ctx;
beforeEach(() => {
  mocks.state.events.clear(); mocks.state.sms.length = 0; mocks.state.optedOut.clear(); mocks.state.vapiDeleted.length = 0;
  mocks.state.failOpenAI = false;
  mocks.state.openaiScript = () => ({ role: "assistant", content: "Thanks! The team will get back to you." });
  cfg = example();
  cfg.booking.shadow_mode = false;
  setupSheet(mocks.state, cfg.google.sheet_id);
  ctx = ctxFor(mocks, cfg);
});

const vapi = (body) => handleVapi(ctx, { headers: vapiHeaders(mocks.env, cfg.id), query: { client: cfg.id }, body });
const tool = async (name, args, opts) => resultOf(await vapi(toolCall(name, args, opts)));
const events = () => [...(mocks.state.events.get(cfg.google.calendar_id)?.values() ?? [])];
const smsTo = (n) => mocks.state.sms.filter((m) => m.to === n);
const OWNER = "+14165550111";
const CALLER = "+19055551234";
const rows = (tab) => mocks.state.sheets.get(cfg.google.sheet_id).get(tab).slice(1);
const smsReq = (params) => {
  const url = "https://n8n.example.com/webhook/firstring-twilio-sms";
  return handleTwilioSms(ctx, { headers: { "X-Twilio-Signature": twilioSign("twilio-token", url, params) }, query: {}, body: params });
};

// ---- security -------------------------------------------------------------------------------
test("rejects wrong Vapi secret, another client's secret, unknown client, bad Twilio signature", async () => {
  const body = toolCall("take_message", { summary: "x" });
  assert.equal((await handleVapi(ctx, { headers: { "x-vapi-secret": "nope" }, query: { client: cfg.id }, body })).status, 401);
  assert.equal((await handleVapi(ctx, { headers: vapiHeaders(mocks.env, "other-shop"), query: { client: cfg.id }, body })).status, 401);
  assert.equal((await handleVapi(ctx, { headers: vapiHeaders(mocks.env, cfg.id), query: { client: "ghost" }, body })).status, 404);
  const r = await handleTwilioSms(ctx, { headers: { "x-twilio-signature": "forged" }, query: {}, body: { From: CALLER, To: cfg.phone.twilio_number, Body: "hi" } });
  assert.equal(r.status, 403);
  assert.equal(mocks.state.sms.length, 0);
});

// ---- Runbook scenario 1 ---------------------------------------------------------------------
test("S1 simple booking: 'oil change, first available Tuesday' → correct slot and details", async () => {
  const avail = await tool("check_availability", { service: "oil change", day_of_week: "tuesday" });
  assert.match(avail, /Tuesday, October 13 at 8 AM/);
  const [slot] = slotIds(avail);
  const res = await tool("book_appointment", { slot_id: slot, customer_name: "Sam Lee", vehicle: "2018 Honda Civic" });
  assert.match(res, /all set for Tuesday, October 13 at 8 AM/);
  const [ev] = events();
  assert.equal(ev.start.dateTime, "2026-10-13T12:00:00.000Z");
  assert.equal(ev.end.dateTime, "2026-10-13T12:45:00.000Z");
  assert.equal(ev.summary, "Oil change — Sam Lee");
  assert.match(ev.description, /2018 Honda Civic/);
  assert.equal(ev.extendedProperties.private.fr_phone, CALLER, "phone comes from the carrier, not the model");
  assert.equal(smsTo(OWNER)[0].body, "FirstRing · Maple Auto Care: New booking: Oil change, Tue, Oct 13, 8:00 am, Sam Lee (+19055551234), 2018 Honda Civic.");
  assert.match(smsTo(CALLER)[0].body, /booked for Oil change/);
  assert.equal(rows("actions")[0][2], "booking");
});

// ---- Runbook scenario 2 ---------------------------------------------------------------------
test("S2 price question + booking: price only from the KB, then books", async () => {
  const prompt = voiceSystemPrompt(cfg);
  assert.match(prompt, /Tire swap \(key tire_swap\): \$79/);
  assert.match(prompt, /Only quote prices listed above/);
  const avail = await tool("check_availability", { service: "tire_swap", earliest_date: "2026-10-14", time_of_day: "afternoon" });
  const [slot] = slotIds(avail);
  assert.match(await tool("book_appointment", { slot_id: slot, customer_name: "Ana", vehicle: "RAV4" }), /all set for Wednesday, October 14 at 12 PM/);
});

// ---- Runbook scenario 3 ---------------------------------------------------------------------
test("S3 reschedule: old slot freed, new slot held", async () => {
  const [slot] = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }));
  await tool("book_appointment", { slot_id: slot, customer_name: "Sam", vehicle: "Civic" });
  const found = await tool("find_booking", {});
  const [bid] = bookingIds(found);
  assert.match(found, /Oil change on Tuesday, October 13 at 8 AM/);
  const newSlot = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "thursday" }))[0];
  assert.match(await tool("reschedule_booking", { booking_id: bid, slot_id: newSlot }), /now Thursday, October 15 at 8 AM, and the old time is released/);
  assert.equal(events().length, 1);
  assert.equal(events()[0].start.dateTime, "2026-10-15T12:00:00.000Z");
  assert.match(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }), /Tuesday, October 13 at 8 AM/, "old slot offered again");
});

// ---- Runbook scenario 4 ---------------------------------------------------------------------
test("S4 cancel: booking removed, owner notified, slot released", async () => {
  const [slot] = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }));
  await tool("book_appointment", { slot_id: slot, customer_name: "Sam" });
  const [bid] = bookingIds(await tool("find_booking", {}));
  assert.match(await tool("cancel_booking", { booking_id: bid }), /is cancelled/);
  assert.equal(events().length, 0);
  assert.match(smsTo(OWNER).at(-1).body, /Cancelled: Sam .* Slot is free again/);
  assert.match(smsTo(CALLER).at(-1).body, /is cancelled/);
});

// ---- Runbook scenario 5 (must-pass) ---------------------------------------------------------
test("S5 complaint: escalates immediately, books nothing, promises a callback", async () => {
  const prompt = voiceSystemPrompt(cfg);
  assert.match(prompt, /ALWAYS escalate_to_owner.*complaints about previous work, damage claims, price disputes/s);
  const res = await tool("escalate_to_owner", { category: "damage_claim", summary: "Says your guy scratched his rim yesterday", customer_name: "Raj" });
  assert.match(res, /owner, and they'll call you back personally/);
  assert.match(smsTo(OWNER)[0].body, /URGENT DAMAGE_CLAIM — Raj \+19055551234: Says your guy scratched his rim/);
  assert.equal(events().length, 0);
  assert.equal(rows("actions")[0][2], "escalation");
});

// ---- shadow mode ----------------------------------------------------------------------------
test("shadow mode: booking is a tentative hold until the owner texts YES <code>", async () => {
  cfg.booking.shadow_mode = true;
  const [slot] = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }));
  assert.match(await tool("book_appointment", { slot_id: slot, customer_name: "Sam", vehicle: "Civic" }), /request .* confirm by text/);
  const [hold] = events();
  assert.equal(hold.status, "tentative");
  assert.match(hold.summary, /^\[PENDING\]/);
  const code = /YES (\d{4})/.exec(smsTo(OWNER)[0].body)[1];
  assert.equal(smsTo(CALLER).length, 0, "customer not told it's confirmed yet");
  assert.match(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }), /Tuesday, October 13 at 9 AM/, "held slot not re-offered");

  const r = await smsReq({ From: OWNER, To: cfg.phone.twilio_number, Body: `yes ${code}` });
  assert.match(r.body, /<Message>Confirmed Sam, Oil change/);
  assert.equal(events()[0].status, "confirmed");
  assert.equal(events()[0].summary, "Oil change — Sam");
  assert.match(smsTo(CALLER)[0].body, /Confirmed: you're booked for Oil change/);
});

test("shadow mode: NO deletes the hold; reschedule YES swaps old for new; approvals only from owner", async () => {
  cfg.booking.shadow_mode = true;
  const [s1] = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }));
  await tool("book_appointment", { slot_id: s1, customer_name: "Sam" });
  const code1 = /YES (\d{4})/.exec(smsTo(OWNER).at(-1).body)[1];
  const spoof = await smsReq({ From: CALLER, To: cfg.phone.twilio_number, Body: `YES ${code1}` });
  assert.equal(events()[0].status, "tentative", "a customer texting YES can't approve");
  assert.doesNotMatch(spoof.body, /Confirmed/);
  await smsReq({ From: OWNER, To: cfg.phone.twilio_number, Body: `NO ${code1}` });
  assert.equal(events().length, 0);
  assert.match(smsTo(CALLER).at(-1).body, /didn't work out. We'll call you/);

  // confirmed booking, then shadow reschedule
  await tool("book_appointment", { slot_id: s1, customer_name: "Sam" });
  await smsReq({ From: OWNER, To: cfg.phone.twilio_number, Body: `YES ${/YES (\d{4})/.exec(smsTo(OWNER).at(-1).body)[1]}` });
  const [bid] = bookingIds(await tool("find_booking", {}));
  const s2 = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "friday" }))[0];
  assert.match(await tool("reschedule_booking", { booking_id: bid, slot_id: s2 }), /current time stays booked until the shop confirms/);
  assert.equal(events().length, 2);
  await smsReq({ From: OWNER, To: cfg.phone.twilio_number, Body: `YES ${/YES (\d{4})/.exec(smsTo(OWNER).at(-1).body)[1]}` });
  assert.equal(events().length, 1);
  assert.equal(events()[0].start.dateTime.slice(0, 10), "2026-10-16");
  assert.match((await smsReq({ From: OWNER, To: cfg.phone.twilio_number, Body: "LIST" })).body, /No pending requests/);
});

// ---- double booking ------------------------------------------------------------------------
test("two callers booking the same slot at the same moment → exactly one booking", async () => {
  const [slot] = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }));
  const [a, b] = await Promise.all([
    tool("book_appointment", { slot_id: slot, customer_name: "First" }, { phone: "+19055550001", id: "a" }),
    tool("book_appointment", { slot_id: slot, customer_name: "Second" }, { phone: "+19055550002", id: "b" }),
  ]);
  assert.equal(events().length, 1);
  assert.equal([a, b].filter((r) => /all set/.test(r)).length, 1);
  assert.match([a, b].find((r) => !/all set/.test(r)), /just taken. The next openings are/);
});

test("can't touch someone else's booking; invalid or past slot refused; tier gating", async () => {
  const [slot] = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }));
  await tool("book_appointment", { slot_id: slot, customer_name: "Owner Of Booking" });
  const [bid] = bookingIds(await tool("find_booking", {}));
  assert.match(await tool("cancel_booking", { booking_id: bid }, { phone: "+19055557777" }), /couldn't find that booking under your number/);
  assert.match(await tool("find_booking", {}, { phone: "+19055557777" }), /don't see any upcoming bookings/);
  assert.match(await tool("book_appointment", { slot_id: "oil_change@2026-10-12T14:30:00.000Z", customer_name: "x" }), /isn't available anymore/); // inside 2h notice
  assert.match(await tool("book_appointment", { slot_id: "made-up", customer_name: "x" }), /check availability first/);
  assert.match(await tool("book_appointment", { slot_id: slotIds(await tool("check_availability", { service: "mobile_tire_swap" }))[0], customer_name: "x" }), /need the address/);
  cfg.tier = "essential";
  assert.match(await tool("check_availability", { service: "oil_change" }), /not something I can do/);
  assert.equal(events().length, 1);
});

// ---- end of call, text-back ----------------------------------------------------------------
const eocr = (over = {}) => ({ message: { type: "end-of-call-report", call: { id: "call_9", customer: { number: CALLER } }, durationSeconds: 95,
  endedReason: "customer-ended-call", analysis: { summary: "Asked about tire storage.", structuredData: { outcome: "question_answered" } },
  artifact: { messages: [{ role: "bot", message: "Hi" }, { role: "user", message: "Do you store tires?" }] }, ...over } });

test("end of call: logged to the sheet (no transcript) and owner gets a summary", async () => {
  assert.equal((await vapi(eocr())).status, 200);
  const [row] = rows("calls");
  assert.deepEqual(row.slice(2), ["call_9", CALLER, "95", "question_answered", "Asked about tire storage.", "customer-ended-call"]);
  assert.match(smsTo(OWNER)[0].body, /call from \+19055551234 \(2 min\)\. Asked about tire storage/);
});

test("hung up on the greeting → one text-back with shop name + STOP; not repeated, not to own numbers, not after STOP", async () => {
  const hangup = eocr({ durationSeconds: 4, artifact: { messages: [{ role: "bot", message: "Hi" }] }, analysis: {} });
  await vapi(hangup);
  assert.equal(smsTo(CALLER).length, 1);
  assert.match(smsTo(CALLER)[0].body, /^Maple Auto Care|Hi, it's Maple Auto Care.*Reply STOP to opt out\.$/);
  await vapi(hangup);
  assert.equal(smsTo(CALLER).length, 1, "not twice in 24 h");
  await vapi(eocr({ durationSeconds: 3, call: { id: "c2", customer: { number: "+19055550122" } }, artifact: { messages: [] } }));
  assert.equal(smsTo("+19055550122").length, 0, "shop's own number (forwarding caller ID) never texted");
  await smsReq({ From: "+19055550333", To: cfg.phone.twilio_number, Body: "STOP" });
  await vapi(eocr({ durationSeconds: 3, call: { id: "c3", customer: { number: "+19055550333" } }, artifact: { messages: [] } }));
  assert.equal(smsTo("+19055550333").length, 0, "opted out");
  cfg.tier = "essential";
  await vapi(eocr({ durationSeconds: 3, call: { id: "c4", customer: { number: "+19055550444" } }, artifact: { messages: [] } }));
  assert.equal(smsTo("+19055550444").length, 0, "Essential tier has no text-back");
});

test("minutes cap: Nion alerted once at 80% and once at 100%", async () => {
  cfg.minutes_cap = 10;
  for (const d of [300, 200, 100, 120]) await vapi(eocr({ durationSeconds: d }));
  const ops = smsTo("+14165559999").map((m) => m.body);
  assert.equal(ops.length, 2);
  assert.match(ops[0], /hit 80% of 10 included minutes/);
  assert.match(ops[1], /hit 100% of 10 included minutes/);
});

// ---- SMS conversation (missed-call recovery) -----------------------------------------------
test("SMS agent books from a text conversation using the texter's number", async () => {
  mocks.state.openaiScript = (messages) => {
    const last = messages.at(-1);
    if (last.role === "user") return { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "check_availability", arguments: JSON.stringify({ service: "oil_change", day_of_week: "tuesday" }) } }] };
    if (last.role === "tool" && last.tool_call_id === "t1") {
      const slot = slotIds(last.content)[0];
      return { role: "assistant", content: null, tool_calls: [{ id: "t2", type: "function", function: { name: "book_appointment", arguments: JSON.stringify({ slot_id: slot, customer_name: "Kim", vehicle: "Mazda 3" }) } }] };
    }
    return { role: "assistant", content: "Booked: Tue Oct 13 at 8 AM for an oil change. See you then!" };
  };
  const r = await smsReq({ From: "+19055550888", To: cfg.phone.twilio_number, Body: "need an oil change tuesday, its Kim, mazda 3" });
  assert.equal(r.status, 200);
  assert.equal(events()[0].extendedProperties.private.fr_phone, "+19055550888");
  assert.match(smsTo("+19055550888").at(-1).body, /^Booked: Tue Oct 13/);
  const sys = mocks.state.openaiCalls.at(-1).messages[0].content;
  assert.match(sys, /Today is 2026-10-12 \(mon\)/);
  assert.deepEqual(rows("sms").map((r) => r[3]), ["in", "out"]);
});

test("SMS agent down → owner gets the text, customer gets a holding reply", async () => {
  mocks.state.failOpenAI = true;
  await smsReq({ From: "+19055550888", To: cfg.phone.twilio_number, Body: "how much for brakes" });
  assert.match(smsTo(OWNER)[0].body, /needs you \(AI unavailable\): how much for brakes/);
  assert.match(smsTo("+19055550888")[0].body, /team will get back to you shortly/);
});

// ---- carrier fallback (Vapi unreachable) ---------------------------------------------------
test("Twilio fallback rings the owner; no answer → apology + text-back", async () => {
  const base = "https://n8n.example.com/webhook/firstring-twilio-voice";
  const p1 = { From: CALLER, To: cfg.phone.twilio_number, CallSid: "CA1" };
  const r1 = await handleTwilioVoiceFallback(ctx, { headers: { "x-twilio-signature": twilioSign("twilio-token", base, p1) }, query: {}, body: p1 });
  assert.match(r1.body, /<Dial timeout="20" action="https:\/\/n8n\.example\.com\/webhook\/firstring-twilio-voice\?step=status">\+14165550111<\/Dial>/);
  const p2 = { ...p1, DialCallStatus: "no-answer" };
  const r2 = await handleTwilioVoiceFallback(ctx, { headers: { "x-twilio-signature": twilioSign("twilio-token", `${base}?step=status`, p2) }, query: { step: "status" }, body: p2 });
  assert.match(r2.body, /<Say[^>]*>Sorry we missed you/);
  assert.match(smsTo(CALLER)[0].body, /Sorry we missed your call/);
});

// ---- scheduled jobs -------------------------------------------------------------------------
test("daily summary at 18:00 local; purge at 03:00 removes expired rows and Vapi calls", async () => {
  const [slot] = slotIds(await tool("check_availability", { service: "oil_change", day_of_week: "tuesday" }));
  await tool("book_appointment", { slot_id: slot, customer_name: "Sam" });
  await vapi(eocr());
  ctx.setNow(new Date("2026-10-12T22:30:00Z")); // 18:30 Toronto
  const done = await runHourly(ctx);
  assert.deepEqual(done.map((d) => d[1]), ["summary"]);
  const sum = smsTo(OWNER).at(-1).body;
  assert.match(sum, /1 calls answered\n1 bookings/);
  assert.match(sum, /\d+\/500 min used this month/);

  ctx.setNow(new Date("2027-01-12T08:30:00Z")); // 03:30 Toronto, > 90 days later
  await vapi(eocr()); // a fresh row that must survive
  const before = rows("calls").length;
  const res = await runHourly(ctx);
  assert.equal(res[0][1], "purge");
  assert.equal(rows("calls").length, 1);
  assert.equal(before, 2);
  assert.deepEqual(mocks.state.vapiDeleted, ["call_9"]);
  assert.equal(rows("actions").length, 0);
});
