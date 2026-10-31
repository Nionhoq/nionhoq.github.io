// Runs the generated Code nodes the way n8n's JS task runner does: same wrapper (Object.defineProperty
// disabled, prototypes frozen) and ONLY the globals n8n exposes (no URL, URLSearchParams, fetch, AbortSignal).
// Both bugs this suite was written for only show up inside n8n.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import crypto from "node:crypto";
import { buildWorkflows } from "../n8n/build.mjs";
import { example } from "./helpers.mjs";
import { startMocks, setupSheet } from "./mocks.mjs";
import { clientSecret } from "../lib/vapi.mjs";

const n8nWrap = (code) => [
  "globalThis.global = globalThis", "var module = { exports: {} }",
  "Object.getPrototypeOf = () => ({})", "Reflect.getPrototypeOf = () => ({})",
  "Object.setPrototypeOf = () => false", "Reflect.setPrototypeOf = () => false",
  "Object.defineProperty = () => ({})", "Object.defineProperties = () => ({})",
  "[Object, Function, Array, String, Number, Boolean, RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError, Promise, Symbol, Map, Set, WeakMap, WeakSet, Date, JSON, Math, Reflect, ArrayBuffer, DataView, Int8Array, Uint8Array, Float32Array, Float64Array].forEach((c) => { try { Object.freeze(c); } catch {} })",
  `module.exports = async function VmCodeWrapper() {${code}\n}()`,
].join("; ");

// n8n-like this.helpers.httpRequest (returnFullResponse) — implemented with Node's fetch OUTSIDE the sandbox.
const helpers = {
  async httpRequest({ method, url, headers, body, timeout }) {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout ?? 15000) });
    return { statusCode: res.status, body: await res.text() };
  },
};

let mocks;
before(async () => { mocks = await startMocks(); });
after(() => mocks.close());

test("generated Code nodes load and make real HTTP calls under n8n's sandbox rules", async () => {
  const cfg = example();
  setupSheet(mocks.state, cfg.google.sheet_id);
  const wfs = await buildWorkflows({ [cfg.id]: cfg });
  const code = wfs.find((w) => w.name === "firstring-vapi").nodes[1].parameters.jsCode
    .replace("helpers: this.helpers", "helpers: HELPERS"); // `this` binding differs in vm; inject the same shape
  const withHelpers = (js) => `const HELPERS = globalThis.__h; ${js}`;
  globalThis.__h = helpers;
  const run = (input) => {
    const context = vm.createContext({
      require: (m) => (m === "crypto" ? crypto : null), console, Buffer, setTimeout, clearTimeout, btoa, atob, TextDecoder, TextEncoder, FormData,
      $env: mocks.env, $input: { first: () => ({ json: input }) }, __h: helpers,
    });
    return vm.runInContext(n8nWrap(withHelpers(code)), context);
  };
  const bad = await run({ headers: { "x-vapi-secret": "wrong" }, query: { client: cfg.id }, body: { message: { type: "tool-calls" } } });
  assert.equal(bad[0].json.status, 401);
  const ok = await run({
    headers: { "x-vapi-secret": clientSecret(crypto, mocks.env.FIRSTRING_MASTER_SECRET, cfg.id) }, query: { client: cfg.id },
    body: { message: { type: "tool-calls", call: { id: "c", customer: { number: "+19055551234" } },
      toolCallList: [{ id: "t", function: { name: "check_availability", arguments: { service: "oil_change", day_of_week: "tuesday" } } }] } },
  });
  assert.equal(ok[0].json.status, 200);
  const result = JSON.parse(ok[0].json.body).results[0].result;
  assert.match(result, /For oil change \(about 45 minutes\), I have Tuesday/, result);
  assert.ok(mocks.state.tokens >= 1, "Google JWT signed inside the sandbox and accepted");
});
