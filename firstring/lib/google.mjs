// Google Calendar + Sheets via a service account (JWT bearer). The client's own calendar
// and sheet are shared with the service account; nothing lives in a personal Google account.
import { localToUtc } from "./time.mjs";
import { form, query, pathOf } from "./encode.mjs";

const SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets";

export function google(ctx) {
  const env = ctx.env;
  const CAL = env.GOOGLE_CALENDAR_BASE ?? "https://www.googleapis.com/calendar/v3";
  const SHEETS = env.GOOGLE_SHEETS_BASE ?? "https://sheets.googleapis.com/v4";
  const TOKEN_URI = env.GOOGLE_TOKEN_URI ?? "https://oauth2.googleapis.com/token";
  let token = null;
  let tokenExp = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: env.GOOGLE_SA_EMAIL, scope: SCOPES, aud: TOKEN_URI, iat: now, exp: now + 3600 })}`;
    const key = String(env.GOOGLE_SA_KEY).replace(/\\n/g, "\n");
    const sig = ctx.crypto.createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
    const res = await ctx.http({
      method: "POST", url: TOKEN_URI,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
    });
    if (res.status !== 200) throw new Error(`google token ${res.status}`);
    token = res.data.access_token;
    tokenExp = Date.now() + (res.data.expires_in ?? 3600) * 1000;
    return token;
  }

  async function call(method, url, body, okStatuses = [200]) {
    const res = await ctx.http({
      method, url,
      headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!okStatuses.includes(res.status)) throw new Error(`google ${method} ${pathOf(url)} → ${res.status}: ${String(res.text).slice(0, 200)}`);
    return res.data;
  }

  const enc = encodeURIComponent;
  const calendar = {
    async list(calId, timeMin, timeMax, privateProps = {}) {
      const q = query([["timeMin", timeMin.toISOString()], ["timeMax", timeMax.toISOString()], ["singleEvents", "true"], ["orderBy", "startTime"], ["maxResults", "250"],
        ...Object.entries(privateProps).map(([k, v]) => ["privateExtendedProperty", `${k}=${v}`])]);
      return (await call("GET", `${CAL}/calendars/${enc(calId)}/events?${q}`)).items ?? [];
    },
    get: (calId, id) => call("GET", `${CAL}/calendars/${enc(calId)}/events/${enc(id)}`, undefined, [200]),
    insert: (calId, ev) => call("POST", `${CAL}/calendars/${enc(calId)}/events`, ev),
    patch: (calId, id, patch) => call("PATCH", `${CAL}/calendars/${enc(calId)}/events/${enc(id)}`, patch),
    remove: (calId, id) => call("DELETE", `${CAL}/calendars/${enc(calId)}/events/${enc(id)}`, undefined, [200, 204, 410]),
  };

  const sheets = {
    async append(sheetId, tab, rows) {
      return call("POST", `${SHEETS}/spreadsheets/${enc(sheetId)}/values/${enc(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
    },
    async read(sheetId, tab) {
      return (await call("GET", `${SHEETS}/spreadsheets/${enc(sheetId)}/values/${enc(`${tab}!A:Z`)}`)).values ?? [];
    },
    /** Delete data rows [fromRow, toRow) (0-based, header is row 0). */
    async deleteRows(sheetId, tab, fromRow, toRow) {
      const meta = await call("GET", `${SHEETS}/spreadsheets/${enc(sheetId)}?fields=sheets.properties`);
      const sheet = meta.sheets.find((s) => s.properties.title === tab);
      if (!sheet) throw new Error(`tab ${tab} missing`);
      return call("POST", `${SHEETS}/spreadsheets/${enc(sheetId)}:batchUpdate`, {
        requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: "ROWS", startIndex: fromRow, endIndex: toRow } } }],
      });
    },
    async ensureTabs(sheetId, tabs) {
      const meta = await call("GET", `${SHEETS}/spreadsheets/${enc(sheetId)}?fields=sheets.properties`);
      const have = new Set(meta.sheets.map((s) => s.properties.title));
      const missing = Object.keys(tabs).filter((t) => !have.has(t));
      if (missing.length) {
        await call("POST", `${SHEETS}/spreadsheets/${enc(sheetId)}:batchUpdate`, { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) });
        for (const t of missing) await sheets.append(sheetId, t, [tabs[t]]);
      }
      return missing;
    },
  };

  return { calendar, sheets };
}

/** Google event → busy interval used by the scheduler. Cancelled / "free" events don't block. */
export function toBusy(ev, tz) {
  if (ev.status === "cancelled" || ev.transparency === "transparent") return null;
  const allDay = !ev.start?.dateTime;
  const start = allDay ? localToUtc(ev.start.date, "00:00", tz) : new Date(ev.start.dateTime);
  const end = allDay ? localToUtc(ev.end.date, "00:00", tz) : new Date(ev.end.dateTime);
  return { id: ev.id, start, end, allDay, isJob: !allDay, created: ev.created, fr: ev.extendedProperties?.private?.fr === "1" };
}
