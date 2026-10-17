// Integration: real Postgres (TEST_DATABASE_URL) + in-process mock of VAPI and Cloudflare APIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.TEST_DATABASE_URL;
const provision = new URL("../provision.mjs", import.meta.url).pathname;

// Unique per run so the suite is hermetic against a reused database.
const RUN = Date.now().toString().slice(-7);
const NUM = `+1416${RUN}`;
const CLIENT = `client_t${RUN}`;

function mockApis(t) {
  const calls = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/phone-number") return res.end(JSON.stringify([{ id: `ph_${RUN}`, number: NUM }]));
      if (req.method === "POST") return res.end(JSON.stringify({ id: `${req.url.split("/")[1]}_${++n}` }));
      res.end("{}");
    });
  });
  t.after(() => server.close());
  return new Promise((r) => server.listen(0, () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

const run = (cfgPath, envExtra) => new Promise((resolve) => {
  execFile(process.execPath, [provision, cfgPath, "--apply"], { env: { ...process.env, ...envExtra } }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test("apply provisions end-to-end and is idempotent", { skip: !DB && "TEST_DATABASE_URL not set" }, async (t) => {
  const { calls, url } = await mockApis(t);
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  const cfg = JSON.parse(readFileSync(new URL("../examples/acme.client_config.json", import.meta.url)));
  cfg.client_id = CLIENT;
  cfg.telephony.phone_numbers[0].number = NUM;
  cfg.vapi_assistant.voice.voices_by_language = { "fr-CA": "fr_voice", "es-US": "es_voice" };
  const cfgPath = join(dir, "acme.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const env = { DATABASE_URL: DB, VAPI_API_KEY: "vk", VAPI_WEBHOOK_SECRET: "whs", EDGE_BASE_URL: "https://edge.test",
    VAPI_BASE_URL: url, CF_API_BASE: url, CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "cft", CF_KV_NAMESPACE_ID: "ns" };

  const r1 = await run(cfgPath, env);
  assert.equal(r1.code, 0, r1.stderr + r1.stdout);
  const posts1 = calls.filter((c) => c.method === "POST").map((c) => c.path);
  assert.deepEqual(posts1, ["/assistant", "/assistant", "/assistant", "/squad"]);
  const phonePatch = calls.find((c) => c.path === `/phone-number/ph_${RUN}`);
  assert.deepEqual(phonePatch.body, { assistantId: null, squadId: null, server: { url: "https://edge.test/webhook/vapi-tool-call", timeoutSeconds: 3, secret: "whs" } });
  assert.ok(calls.some((c) => c.method === "PUT" && /tenant:profile:/.test(c.path)));
  assert.ok(calls.filter((c) => c.path.startsWith("/accounts")).every((c) => c.auth === "Bearer cft"));
  assert.ok(calls.filter((c) => !c.path.startsWith("/accounts")).every((c) => c.auth === "Bearer vk"));

  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  t.after(() => db.end());
  const { rows: [tn] } = await db.query("SELECT * FROM voice.tenants WHERE client_key = $1", [CLIENT]);
  assert.equal(tn.status, "active");
  assert.equal(tn.jurisdiction, "CA-ON");
  assert.equal(tn.vapi_squad_id, "squad_4");
  assert.deepEqual(Object.keys(tn.vapi_assistant_ids).sort(), ["en-US", "es-US", "fr-CA"]);
  const { rows: [r] } = await db.query("SELECT * FROM voice.resolve_tenant_by_vapi_phone($1)", [`ph_${RUN}`]);
  assert.equal(r.max_concurrent_calls, 50);
  assert.equal(r.failover_number, "+18005550100");

  // Second run: no new resources, everything PATCHed.
  calls.length = 0;
  const r2 = await run(cfgPath, env);
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(calls.filter((c) => c.method === "POST"), []);
  assert.deepEqual(calls.filter((c) => c.method === "PATCH").map((c) => c.path).sort(),
    ["/assistant/assistant_1", "/assistant/assistant_2", "/assistant/assistant_3", `/phone-number/ph_${RUN}`, "/squad/squad_4"]);

  // Another client trying to claim the same number is refused by RLS.
  const other = { ...cfg, client_id: `${CLIENT}_other`, client_name: "Other" };
  writeFileSync(cfgPath, JSON.stringify(other));
  calls.length = 0;
  const r3 = await run(cfgPath, env);
  assert.notEqual(r3.code, 0);
  assert.match(r3.stderr, /already belongs to another tenant/);
  assert.equal(calls.filter((c) => c.method !== "GET" && c.path.startsWith("/phone-number")).length, 0, "VAPI number must not be re-pointed");
  const { rows: [o] } = await db.query("SELECT status FROM voice.tenants WHERE client_key = $1", [`${CLIENT}_other`]);
  assert.equal(o.status, "pending");

});

test("apply refuses when the number isn't imported into VAPI", { skip: !DB && "TEST_DATABASE_URL not set" }, async (t) => {
  const { url } = await mockApis(t);
  const dir = mkdtempSync(join(tmpdir(), "prov-"));
  const cfg = JSON.parse(readFileSync(new URL("../examples/acme.client_config.json", import.meta.url)));
  cfg.client_id = `${CLIENT}_missing`;
  cfg.vapi_assistant.voice.voices_by_language = {};
  cfg.telephony.phone_numbers[0].number = "+14165550123";
  const p = join(dir, "c.json");
  writeFileSync(p, JSON.stringify(cfg));
  const r = await run(p, { DATABASE_URL: DB, VAPI_API_KEY: "vk", VAPI_WEBHOOK_SECRET: "whs", EDGE_BASE_URL: "https://edge.test",
    VAPI_BASE_URL: url, CF_API_BASE: url, CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t", CF_KV_NAMESPACE_ID: "n" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not imported into VAPI yet: \+14165550123 \(twilio\)/);
});
