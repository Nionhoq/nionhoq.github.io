// Vapi: per-client webhook secret (derived, so nothing extra to store) and call deletion.
import { safeEqual } from "./twilio.mjs";

export function clientSecret(crypto, master, clientId) {
  return crypto.createHmac("sha256", master).update(`vapi:${clientId}`).digest("hex");
}

export function verifyVapi(ctx, clientId, headers) {
  const got = headers["x-vapi-secret"] ?? headers["X-Vapi-Secret"];
  return safeEqual(clientSecret(ctx.crypto, ctx.env.FIRSTRING_MASTER_SECRET, clientId), String(got ?? ""));
}

export async function deleteVapiCall(ctx, callId) {
  const base = ctx.env.VAPI_API_BASE ?? "https://api.vapi.ai";
  const res = await ctx.http({ method: "DELETE", url: `${base}/call/${encodeURIComponent(callId)}`, headers: { authorization: `Bearer ${ctx.env.VAPI_API_KEY}` } });
  if (![200, 204, 404].includes(res.status)) throw new Error(`vapi delete call ${res.status}`);
}
