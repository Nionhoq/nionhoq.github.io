// Intake config validation: JSON Schema + the cross-field rules a schema can't express.
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(readFileSync(new URL("../schema/client.schema.json", import.meta.url)));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const check = ajv.compile(schema);

export function validateClient(cfg, { apply = false, others = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!check(cfg)) {
    for (const e of check.errors) errors.push(`${e.instancePath || "/"} ${e.message}`);
    return { errors, warnings };
  }
  try { new Intl.DateTimeFormat("en", { timeZone: cfg.timezone }); } catch { errors.push(`timezone "${cfg.timezone}" is not a valid IANA zone`); }
  for (const [d, ranges] of Object.entries(cfg.hours)) for (const [a, b] of ranges) if (a >= b) errors.push(`hours.${d}: ${a}-${b} start must be before end`);
  if (!Object.values(cfg.hours).some((r) => r.length)) errors.push("hours: the shop is never open");
  const keys = cfg.services.map((s) => s.key);
  if (new Set(keys).size !== keys.length) errors.push("services: duplicate key");
  const own = [cfg.phone.twilio_number, ...(cfg.phone.shop_numbers ?? [])];
  if (own.includes(cfg.phone.owner_mobile)) errors.push("phone.owner_mobile must be the owner's own mobile, not the shop or FirstRing number (approvals are trusted from it)");
  for (const o of others) {
    if (o.id === cfg.id) continue;
    if (o.phone?.twilio_number === cfg.phone.twilio_number) errors.push(`phone.twilio_number already used by client ${o.id}`);
  }
  const placeholder = JSON.stringify(cfg.google).includes("REPLACE") || JSON.stringify(cfg.voice ?? {}).includes("REPLACE");
  if (placeholder) (apply ? errors : warnings).push("google / voice still contain REPLACE placeholders");
  if (!cfg.booking.shadow_mode && cfg.tier !== "essential") warnings.push("shadow_mode is off: runbook rule 4 requires 2 clean weeks in shadow mode first");
  if (!cfg.minutes_cap) warnings.push("minutes_cap is 0 (unlimited): a busy shop can cost more than its plan");
  if (cfg.tier === "essential" && cfg.booking.shadow_mode) warnings.push("Essential tier has no booking; shadow_mode has no effect");
  for (const s of cfg.services) if (s.mobile && !(cfg.service_area ?? []).length) warnings.push(`service ${s.key} is mobile but service_area is empty`);
  return { errors, warnings };
}
