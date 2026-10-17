// Builds the `ctx` every handler receives. In n8n: helpers.httpRequest (or fetch), $env, require('crypto').
// In tests: fetch, process.env, node:crypto.

export function makeCtx({ helpers, env, clients, crypto, now, reportError }) {
  return {
    env,
    clients,
    crypto,
    now: now ?? (() => new Date()),
    reportError,
    http: helpers?.httpRequest ? n8nHttp(helpers) : fetchHttp,
  };
}

function n8nHttp(helpers) {
  return async ({ method, url, headers = {}, body, timeoutMs = 15_000 }) => {
    const res = await helpers.httpRequest({
      method, url, headers, body, timeout: timeoutMs,
      returnFullResponse: true, ignoreHttpStatusErrors: true, json: false, encoding: "utf8",
    });
    return shape(res.statusCode, res.body);
  };
}

async function fetchHttp({ method, url, headers = {}, body, timeoutMs = 15_000 }) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  return shape(res.status, await res.text());
}

function shape(status, raw) {
  const text = typeof raw === "string" ? raw : raw == null ? "" : Buffer.isBuffer(raw) ? raw.toString("utf8") : JSON.stringify(raw);
  let data = typeof raw === "object" && raw !== null && !Buffer.isBuffer(raw) ? raw : null;
  if (data === null && text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { status, data, text };
}
