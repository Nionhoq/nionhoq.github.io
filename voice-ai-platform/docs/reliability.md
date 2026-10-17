# Reliability: Error Handling, Retries, State

## 1. Failure classes and policy

| Failure | Retry? | Policy |
|---|---|---|
| Network / 5xx / 429 from downstream (CRM, EHR, VAPI API) | Yes | Exponential backoff with full jitter: `min(cap, base·2^n)·rand()`, base 500 ms, cap 30 s, max 5 attempts. Honor `Retry-After`. |
| 4xx validation (400/404/422) | No | Fail fast → DLQ with `retryable=false`. Retrying a bad payload just repeats the error. |
| 401/403 | No (once) | Refresh token once, then DLQ + alert tenant admin. |
| Timeout on a **sync tool call** | No | Return a speakable fallback (`"I'm having trouble reaching the calendar — let me transfer you"`) inside the budget. Never let the caller sit in silence. |
| Duplicate webhook delivery | N/A | Idempotency key dedupe (below). |
| n8n worker crash mid-execution | Yes | Queue mode re-delivers. Steps must be idempotent. |

**In n8n:** use node-level `retryOnFail: true, maxTries: 3, waitBetweenTries: 2000`
for transient HTTP failures (already set on HTTP nodes in the exported workflows),
and `continueOnFail`/error output **only** where you handle the error branch
explicitly. Everything else bubbles to `99-error-handler.json`.

## 2. Idempotency

Every inbound event gets a deterministic key, recorded **before** side effects:

| Event | Key |
|---|---|
| Tool call | `toolCallId` (VAPI-assigned, unique per invocation) |
| end-of-call-report | `call.id + ':eocr'` |
| status-update | `call.id + ':' + status` |
| Outbound dial request | `campaign_id + ':' + contact_id + ':' + attempt_no` |

`INSERT INTO idempotency_keys (...) ON CONFLICT DO NOTHING RETURNING key`.
No row returned → duplicate → return the stored `response` (for tools) or 200 no-op.

## 3. State management

- **Per-call conversational state** (identity verified? which appointment offered?)
  lives in `call_state` keyed by `vapi_call_id`, not in n8n static data. n8n static
  data is per-workflow, not concurrency-safe, and doesn't work across queue-mode
  workers.
- **Short-lived hot state** (tenant config, availability cache) goes in edge KV with a TTL.
  Invalidate on admin write.
- **Long-running flows** (callbacks, multi-day outbound cadences): persist a row in
  `outbound_jobs` with `status`, `next_attempt_at`, `attempt_no`. A scheduled
  n8n trigger (every minute) claims due rows with
  `FOR UPDATE SKIP LOCKED`. Don't use n8n `Wait` nodes for anything longer than
  minutes, because they pin executions and don't survive version upgrades cleanly.

## 4. Dead-letter queue

`99-error-handler.json` (set as the **Error Workflow** in each workflow's settings)
writes to `dead_letters` with: workflow, node, error message, redacted payload,
`retryable`, `tenant_id`. Replay = re-POST the stored payload to the original
workflow's webhook with header `X-Replay-Of: <dead_letter_id>`. The idempotency
layer makes replay safe.

Alert thresholds (per tenant, 5-min window): any HIPAA-tenant DLQ entry → page;
> 5 non-retryable → Slack; tool-call p95 > 1.5 s → Slack.

## 5. Observability

- Trace ID = VAPI `call.id`. Log it at edge, n8n (`$execution.customData.set`), and DB.
- Metrics: tool latency per tool per tenant, assistant-request latency, DLQ depth,
  consent-gate rejections (a spike means a bad list upload, not a bug).
- **Never log tool arguments or results** for HIPAA tenants. Log names, durations,
  and status only.

## 6. Not included (yet)

- **Jobs stuck in `dialing`.** If n8n dies between VAPI accepting `POST /call` and
  `finish_outbound_job`, the job stays `dialing`. Auto-requeueing risks a duplicate
  call to a real person, so route `dialing` jobs older than 15 min **with no
  `vapi_call_id`** to manual review, or reconcile them against VAPI's call list.
- DSAR (access/erasure) orchestration workflow: needs your CRM/EHR connectors.
- Load-test harness. Use VAPI's test-call API or a SIP load generator
  against staging, and target 2× expected peak concurrent calls.
- Per-tenant cost metering/billing.
