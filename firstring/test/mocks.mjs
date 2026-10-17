// One in-process HTTP server standing in for Google (OAuth, Calendar, Sheets), Twilio, OpenAI and Vapi.
// Behaves like the real APIs for the calls FirstRing makes: overlap queries, private extended
// property filters, created timestamps, value append/read, row deletion, STOP opt-outs.
import { createServer } from "node:http";
import { generateKeyPairSync, createVerify, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Test-only service-account key. FR_TEST_KEY_DIR persists it so a long-running n8n (e2e) keeps a valid key.
function testKey() {
  const dir = process.env.FR_TEST_KEY_DIR;
  if (dir && existsSync(join(dir, "sa.pem"))) return { privateKey: readFileSync(join(dir, "sa.pem"), "utf8"), publicKey: readFileSync(join(dir, "sa.pub"), "utf8") };
  const k = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  if (dir) { writeFileSync(join(dir, "sa.pem"), k.privateKey); writeFileSync(join(dir, "sa.pub"), k.publicKey); }
  return k;
}
export const { privateKey: SA_KEY, publicKey: SA_PUB } = testKey();

export async function startMocks(port = 0) {
  const state = {
    events: new Map(), // calendarId -> Map(id -> event)
    sheets: new Map(), // sheetId -> Map(tab -> rows[][])
    sms: [], optedOut: new Set(), vapiDeleted: [], openaiScript: null, openaiCalls: [], tokens: 0,
    vapi: { assistants: new Map(), phones: [{ id: "ph_1", number: "+16475550100" }] , requests: [] },
    twilioNumbers: [{ sid: "PN1", phone_number: "+16475550100" }], twilioUpdates: [],
    failOpenAI: false,
  };
  let seq = 0;
  let clock = 0;
  const cal = (id) => state.events.get(id) ?? state.events.set(id, new Map()).get(id);
  const sheet = (id) => state.sheets.get(id) ?? state.sheets.set(id, new Map()).get(id);

  const server = createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e.message)); }));
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    let raw = "";
    for await (const c of req) raw += c;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
    const p = url.pathname;
    const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw;
    const authed = () => req.headers.authorization === "Bearer test-access-token";

    // ---- Google OAuth (verifies the service-account JWT signature)
    if (p === "/token") {
      const assertion = new URLSearchParams(raw).get("assertion") ?? "";
      const [h, c, s] = assertion.split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(SA_PUB, Buffer.from(s ?? "", "base64url"));
      const claims = JSON.parse(Buffer.from(c ?? "", "base64url").toString() || "{}");
      if (!ok || !claims.scope?.includes("calendar")) return send(401, { error: "invalid_grant" });
      state.tokens++;
      return send(200, { access_token: "test-access-token", expires_in: 3600 });
    }

    // ---- Calendar
    let m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(p);
    if (m) {
      if (!authed()) return send(401, {});
      const c = cal(decodeURIComponent(m[1]));
      const evId = m[2] && decodeURIComponent(m[2]);
      if (req.method === "GET" && !evId) {
        const tMin = Date.parse(url.searchParams.get("timeMin"));
        const tMax = Date.parse(url.searchParams.get("timeMax"));
        const props = url.searchParams.getAll("privateExtendedProperty").map((x) => x.split("="));
        const items = [...c.values()]
          .filter((e) => e.status !== "cancelled")
          .filter((e) => Date.parse(e.start.dateTime ?? e.start.date) < tMax && Date.parse(e.end.dateTime ?? e.end.date) > tMin)
          .filter((e) => props.every(([k, v]) => (e.extendedProperties?.private?.[k] ?? "") === v))
          .sort((a, b) => Date.parse(a.start.dateTime ?? a.start.date) - Date.parse(b.start.dateTime ?? b.start.date));
        return send(200, { items });
      }
      if (req.method === "POST") {
        const id = `ev${++seq}`;
        const ev = { ...body, id, created: new Date(1_800_000_000_000 + ++clock * 1000).toISOString(), status: body.status ?? "confirmed" };
        c.set(id, ev);
        return send(200, ev);
      }
      const ev = c.get(evId);
      if (!ev) return send(404, { error: "notFound" });
      if (req.method === "GET") return send(200, ev);
      if (req.method === "PATCH") { Object.assign(ev, body); return send(200, ev); }
      if (req.method === "DELETE") { c.delete(evId); return send(204); }
    }

    // ---- Sheets
    m = /^\/v4\/spreadsheets\/([^/:]+)(?::batchUpdate|\/values\/([^/:]+)(:append)?)?$/.exec(p);
    if (m) {
      if (!authed()) return send(401, {});
      const s = sheet(decodeURIComponent(m[1]));
      if (p.endsWith(":batchUpdate")) {
        for (const r of body.requests) {
          if (r.addSheet) s.set(r.addSheet.properties.title, []);
          if (r.deleteDimension) {
            const tab = [...s.keys()][r.deleteDimension.range.sheetId];
            s.get(tab).splice(r.deleteDimension.range.startIndex, r.deleteDimension.range.endIndex - r.deleteDimension.range.startIndex);
          }
        }
        return send(200, {});
      }
      if (!m[2]) return send(200, { sheets: [...s.keys()].map((title, i) => ({ properties: { title, sheetId: i } })) });
      const tab = decodeURIComponent(m[2]).split("!")[0];
      if (!s.has(tab)) return send(400, { error: `Unable to parse range: ${tab}` });
      if (m[3]) { s.get(tab).push(...body.values.map((r) => r.map(String))); return send(200, {}); }
      return send(200, { values: s.get(tab) });
    }

    // ---- Twilio
    m = /^\/2010-04-01\/Accounts\/([^/]+)\/(Messages|IncomingPhoneNumbers)(?:\/([^/.]+))?\.json$/.exec(p);
    if (m) {
      if (m[2] === "IncomingPhoneNumbers") {
        if (req.method === "GET") return send(200, { incoming_phone_numbers: state.twilioNumbers.filter((n) => n.phone_number === url.searchParams.get("PhoneNumber")) });
        state.twilioUpdates.push({ sid: m[3], ...Object.fromEntries(new URLSearchParams(raw)) });
        return send(200, { sid: m[3] });
      }
      const f = Object.fromEntries(new URLSearchParams(raw));
      if (state.optedOut.has(f.To)) return send(400, { code: 21610, message: "unsubscribed recipient" });
      state.sms.push({ from: f.From, to: f.To, body: f.Body });
      return send(201, { sid: `SM${state.sms.length}` });
    }

    // ---- OpenAI
    if (p === "/v1/chat/completions") {
      state.openaiCalls.push(body);
      if (state.failOpenAI) return send(500, { error: "down" });
      const message = state.openaiScript(body.messages, body.tools);
      return send(200, { choices: [{ message }] });
    }

    // ---- n8n public API (minimal)
    if (p.startsWith("/api/v1/workflows")) {
      if (req.headers["x-n8n-api-key"] !== "n8n-key") return send(401, {});
      state.n8n ??= new Map();
      const mm = /^\/api\/v1\/workflows(?:\/([^/]+))?(\/activate)?$/.exec(p);
      if (req.method === "GET") return send(200, { data: [...state.n8n.entries()].map(([id, w]) => ({ id, name: w.name })), nextCursor: null });
      if (req.method === "POST" && !mm[1]) { const id = `wf${state.n8n.size + 1}`; state.n8n.set(id, { ...body, active: false }); return send(200, { id }); }
      if (req.method === "PUT") { state.n8n.set(mm[1], { ...body, active: state.n8n.get(mm[1]).active }); return send(200, { id: mm[1] }); }
      if (mm[2]) { state.n8n.get(mm[1]).active = true; return send(200, {}); }
    }

    // ---- Vapi
    state.vapi.requests.push({ method: req.method, path: p, body });
    m = /^\/call\/(.+)$/.exec(p);
    if (m && req.method === "DELETE") { state.vapiDeleted.push(m[1]); return send(200, {}); }
    if (p === "/phone-number" && req.method === "GET") return send(200, state.vapi.phones);
    if (p === "/phone-number" && req.method === "POST") { const ph = { id: `ph_${++seq}`, ...body }; state.vapi.phones.push(ph); return send(201, ph); }
    m = /^\/phone-number\/(.+)$/.exec(p);
    if (m && req.method === "PATCH") { Object.assign(state.vapi.phones.find((x) => x.id === m[1]), body); return send(200, {}); }
    if (p === "/assistant" && req.method === "POST") { const id = `asst_${++seq}`; state.vapi.assistants.set(id, body); return send(201, { id }); }
    m = /^\/assistant\/(.+)$/.exec(p);
    if (m && req.method === "PATCH") { state.vapi.assistants.set(m[1], body); return send(200, { id: m[1] }); }

    send(404, { error: `mock: no route ${req.method} ${p}` });
  }
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state, base, close: () => new Promise((r) => server.close(r)),
    env: {
      GOOGLE_SA_EMAIL: "firstring@test.iam.gserviceaccount.com",
      GOOGLE_SA_KEY: SA_KEY,
      GOOGLE_TOKEN_URI: `${base}/token`,
      GOOGLE_CALENDAR_BASE: `${base}/calendar/v3`,
      GOOGLE_SHEETS_BASE: `${base}/v4`,
      TWILIO_API_BASE: base, TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "twilio-token",
      OPENAI_BASE_URL: base, OPENAI_API_KEY: "sk-test",
      VAPI_API_BASE: base, VAPI_API_KEY: "vapi-key",
      FIRSTRING_MASTER_SECRET: "master-secret",
      FIRSTRING_WEBHOOK_BASE: "https://n8n.example.com",
      NION_ALERT_PHONE: "+14165559999",
      FIRSTRING_OPS_SMS_FROM: "+16475550199",
    },
  };
}

/** Twilio signature for a POST to `url` with form params (what Twilio itself would send). */
export function twilioSign(token, url, params) {
  return createHmac("sha1", token).update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
}

export function setupSheet(state, sheetId) {
  const s = new Map([["calls", [["at_utc", "local_time", "call_id", "caller", "duration_s", "outcome", "summary", "ended_reason"]]],
    ["actions", [["at_utc", "local_time", "kind", "phone", "detail", "event_id"]]],
    ["sms", [["at_utc", "local_time", "phone", "direction", "body"]]]]);
  state.sheets.set(sheetId, s);
  return s;
}
