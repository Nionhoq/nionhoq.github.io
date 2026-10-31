# Compliance Guardrails — Control Matrix

Engineering controls mapped to obligations. **Not legal advice.** Each control names
where it is enforced so it can be tested, not just documented.

Enforcement points: **EDGE** = `edge/worker.ts` · **DB** = `db/schema.sql` · **ONB** = `onboarding/` ·
**DIAL** = `n8n/02-outbound-dialer.json` · **VAPI** = `vapi/assistant.base.json` ·
**N8N** = n8n instance config · **ORG** = contract/process.

---

## 0. The gaps most teams miss

1. **n8n execution logs are a PHI/PII store.** By default n8n persists every node's
   input and output, including transcripts, phone numbers, and DOBs, in its own database.
   For regulated workflows, set `saveDataSuccessExecution: "none"` per workflow
   (already set in the exported JSON) **and** `EXECUTIONS_DATA_PRUNE=true`,
   `EXECUTIONS_DATA_MAX_AGE=24` instance-wide. Error executions are still saved, so
   redact before any node that can throw.
2. **Every vendor in the audio path needs a BAA for HIPAA:** VAPI, the STT provider,
   the LLM provider, the TTS provider, telephony (if not VAPI-provisioned), n8n hosting
   (self-host; don't assume n8n Cloud will sign), Postgres host, and log/APM vendor.
   One missing BAA breaks the chain.
3. **The FCC classifies AI-generated voices as "artificial voice"** (Feb 2024
   declaratory ruling). Every outbound AI call to a cell phone needs prior express
   consent, and telemarketing calls need prior express **written** consent. "We're
   just using AI, not a robocall" is not a defense.
4. **PIPEDA isn't the whole Canadian picture.** Quebec's Law 25 is stricter: it
   requires a privacy impact assessment before transferring data outside Quebec
   (which is almost every US-hosted voice stack) and disclosure of automated
   decisions. The CRTC Unsolicited Telecommunications Rules and National DNCL govern
   outbound calling separately.
5. **EU AI Act Art. 50 transparency obligations** (applicable from Aug 2026) require
   telling people they're interacting with an AI. The `firstMessage` disclosure in
   `vapi/assistant.base.json` covers this. Keep it on for every jurisdiction, not just the EU.

---

6. **"Scrub PII before it reaches the LLM" is not achievable on a live call.** VAPI
   streams the transcript to the LLM directly, and the model needs the caller's words
   ("my name is…", "my appointment on the 12th") to do its job. Inserting a redaction
   proxy (VAPI custom-LLM endpoint) adds a network hop to every turn and breaks the
   conversation whenever it redacts something the model needed. What is enforceable:
   - **LLM side.** Contract, not code: a BAA (HIPAA) or DPA with zero data retention, and no
     training on inputs, with the LLM provider. Use `azure-openai` or another BAA-covered
     endpoint for HIPAA tenants; onboarding warns when it isn't.
   - **Everything around the call.** Tools return minimal fields; the edge never logs
     arguments or results. n8n `Redact & map` strips transcripts before storage, and the
     error handler redacts phone numbers and emails. VAPI summaries are off for HIPAA tenants.
7. **Quebec's Charter of the French Language** (as amended by Bill 96) expects service in
   French. Onboarding refuses a `CA-QC` client without `fr-CA` support.

## 1. TCPA (US) + state mini-TCPAs

> **Inbound-only deployments:** TCPA/CRTC rules on consent, calling hours and DNC govern
> calls *you* place. For inbound they apply only to **callbacks**. The edge records a
> caller's callback request as express consent (`purpose='callback'`, 30-day expiry, call
> id as evidence). A callback to a number on the internal DNC list still needs human
> review, because the DNC entry is deliberately not auto-removed. The calling-hours rows
> below apply to callbacks too.

| Obligation | Control | Where |
|---|---|---|
| Prior express (written for marketing) consent before AI-voice calls to wireless | `consents` row with `channel='voice_ai'`, `consent_type`, `evidence_uri` required; dialer hard-fails without it | DB, DIAL |
| Calling hours 8 AM–9 PM **callee local time** | Timezone resolved from `contacts.timezone` (fallback: area-code lookup, and if ambiguous, **don't call**) | DIAL |
| Stricter state windows (e.g. FL 8 AM–8 PM, plus per-state daily attempt caps) | `calling_rules` table keyed by state; strictest rule wins | DB, DIAL |
| National DNC + internal DNC | `dnc_entries` checked at dial time (not at list upload) | DB, DIAL |
| Revocation by "any reasonable means," honored promptly | `request_opt_out` tool available in **every** assistant; writes DNC + revokes consent synchronously | EDGE, VAPI |
| Caller identification at call start | `firstMessage` names business + states it's an automated AI assistant | VAPI |
| Call recording consent (two-party states: CA, FL, IL, MD, MA, MT, NH, PA, WA, …) | Recording disclosure in `firstMessage` of every locale whenever recording is on; disclosure text is generated per language by onboarding | VAPI, onboarding |
| Valid, attested caller ID | Use numbers with STIR/SHAKEN A-attestation; one registered CNAM per tenant | ORG |
| Audit trail | `calls` + `consents` immutable; `consent_events` append-only | DB |

## 2. HIPAA (US, covered entities & business associates)

| Obligation | Control | Where |
|---|---|---|
| BAA with every subprocessor touching PHI | Vendor register; config schema requires `baa_verified_at`; DB refuses activation without it | ORG, ONB, DB |
| HIPAA config hygiene | Schema forces `recording_enabled=false` and retention ≤ 30 days when `hipaa_mode` is true | ONB |
| Don't persist PHI at vendors without need | `compliancePlan.hipaaEnabled: true` (disables VAPI-side recording/transcript retention) for HIPAA tenants | VAPI |
| Minimum necessary | Tools return only fields the conversation needs; `lookup_customer` never returns DOB/SSN/full address | EDGE |
| Identity verification before disclosing PHI | `verify_identity` tool gate; PHI tools reject unless `call_state.identity_verified=true` | EDGE, DB |
| Encryption in transit / at rest | TLS 1.2+ everywhere; Postgres storage encryption; `pgcrypto` for transcript columns | DB, ORG |
| Audit controls (§164.312(b)) | `audit_log` append-only, written by DB trigger, not by app code | DB |
| No PHI in n8n execution history | `saveDataSuccessExecution: "none"`; redaction before error-prone nodes | N8N |
| No PHI in logs/APM | Edge logs request IDs and tool names only, never args or results | EDGE |
| Retention | Transcripts purged per `tenants.retention_days` (default 30 for HIPAA tenants) by scheduled job | DB |

## 3. GDPR (EU/EEA/UK)

| Obligation | Control | Where |
|---|---|---|
| Lawful basis per purpose | `consents.lawful_basis` (consent / contract / legitimate_interest) recorded per purpose | DB |
| Transparency + AI disclosure (also AI Act Art. 50) | `firstMessage` disclosure; privacy notice URL offered via SMS on request | VAPI |
| Data residency / transfers | EU tenants: EU-region Postgres + n8n; verify VAPI/LLM/STT region support or rely on SCCs + TIA | ORG, DB |
| DPIA before processing | `EU-*` config requires `pia_completed_at` | ONB |
| Art. 17 erasure, Art. 15 access | `dsar_requests` table + n8n workflow (not included, see reliability.md §6) that erases across DB, CRM, VAPI call logs | DB |
| Art. 22 automated decisions | Agents must not make legally significant decisions (credit, eligibility) without human review; `transfer_to_human` always available | VAPI |
| DPIA | Required for large-scale voice processing; template outside this repo | ORG |
| Storage limitation | `retention_days` purge job; recordings off by default | DB, VAPI |
| Biometric data | **Don't** enable voice-print / speaker identification. That makes it Art. 9 special-category data | VAPI |

## 4. PIPEDA (Canada) + Quebec Law 25 + CRTC

| Obligation | Control | Where |
|---|---|---|
| Meaningful consent, purpose identification | Same `consents` model; purpose stated in `firstMessage` | DB, VAPI |
| Quebec: PIA before cross-border transfer | `CA-QC` config requires `pia_completed_at`; DB refuses activation without it | ONB, DB, ORG |
| Quebec: service in French | `CA-QC` config must include `fr-CA` | ONB |
| Quebec: notice of automated decision | Same human-transfer control as GDPR Art. 22 | VAPI |
| CRTC telemarketing hours (weekdays 9:00–21:30, weekends 10:00–18:00 callee local) | `calling_rules` rows for `CA` | DB, DIAL |
| National DNCL + internal DNC (honor within 14 days, keep 3 years) | `dnc_entries` with `source='CA_DNCL'`, retention enforced | DB |
| Breach of security safeguards reporting / record keeping | `security_incidents` log retained 24 months | ORG |

## 5. Prompt-level guardrails (all tenants)

Enforced in `vapi/assistant.base.json` system prompt and backed by tool-side checks.
**The prompt is not the control.** Every rule below is enforced server-side too.

- Never read back full card numbers, SSNs, or DOBs. Tools don't return them.
- Never claim to be human. If asked, confirm it's an AI.
- On "stop calling," "remove me," or similar opt-out phrasing → call `request_opt_out` immediately.
- On medical emergency language → instruct to call 911 and `transfer_to_human`.
- Out-of-scope or low-confidence → `transfer_to_human`, don't improvise.
