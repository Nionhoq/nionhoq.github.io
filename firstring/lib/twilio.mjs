// Twilio: outbound SMS and inbound webhook signature verification.
import { form } from "./encode.mjs";

export async function sendSms(ctx, from, to, body) {
  const env = ctx.env;
  const base = env.TWILIO_API_BASE ?? "https://api.twilio.com";
  const res = await ctx.http({
    method: "POST",
    url: `${base}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    headers: {
      authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form({ From: from, To: to, Body: body.slice(0, 1500) }),
  });
  // 21610: recipient replied STOP. Not an error for us — they opted out.
  if (res.status === 400 && res.data?.code === 21610) return { optedOut: true };
  if (res.status !== 201 && res.status !== 200) throw new Error(`twilio sms ${res.status}: ${String(res.text).slice(0, 200)}`);
  return { sid: res.data?.sid };
}

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function verifyTwilio(ctx, url, params, signature) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = ctx.crypto.createHmac("sha1", ctx.env.TWILIO_AUTH_TOKEN).update(data).digest("base64");
  return safeEqual(expected, String(signature ?? ""));
}

export function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && a.length > 0;
}

/** +1 NANP E.164 or null. */
export function nanp(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export function twiml(inner = "") {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

export function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}
