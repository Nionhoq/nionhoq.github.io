import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { makeCtx } from "../lib/runtime.mjs";
import { clientSecret } from "../lib/vapi.mjs";

export const example = () => {
  const c = JSON.parse(readFileSync(new URL("../clients/example-autoshop.json", import.meta.url)));
  c.google = { calendar_id: "cal-maple", sheet_id: "sheet-maple" };
  return c;
};

// Monday 12 Oct 2026, 10:00 in Toronto.
export const MON_10AM = new Date("2026-10-12T14:00:00Z");

export function ctxFor(mocks, cfg, now = MON_10AM) {
  let t = now;
  const ctx = makeCtx({ env: mocks.env, clients: { [cfg.id]: cfg }, crypto, now: () => t });
  ctx.setNow = (d) => { t = d; };
  return ctx;
}

export const vapiHeaders = (env, id) => ({ "X-Vapi-Secret": clientSecret(crypto, env.FIRSTRING_MASTER_SECRET, id) });

export function toolCall(name, args, { phone = "+19055551234", callId = "call_1", id = name } = {}) {
  return { message: { type: "tool-calls", call: { id: callId, customer: { number: phone } }, toolCallList: [{ id, function: { name, arguments: args } }] } };
}

export const slotIds = (text) => [...String(text).matchAll(/([a-z0-9_]+@\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g)].map((m) => m[1]);
export const bookingIds = (text) => [...String(text).matchAll(/booking id, do not read aloud: (\S+?)\]/g)].map((m) => m[1]);
export const resultOf = (res) => JSON.parse(res.body).results[0].result;
