// n8n's Code sandbox has no URL / URLSearchParams / fetch. These cover what FirstRing needs.
const enc = (v) => encodeURIComponent(String(v)).replace(/%20/g, "+");

/** application/x-www-form-urlencoded body (Twilio, Google token). */
export const form = (obj) => Object.entries(obj).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");

/** Query string from [key, value] pairs (keys may repeat). */
export const query = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

/** Path part of an absolute URL, for error messages. */
export const pathOf = (url) => String(url).replace(/^[a-z]+:\/\/[^/]+/i, "").split("?")[0];
