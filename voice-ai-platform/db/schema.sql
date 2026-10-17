-- Enterprise Voice AI Platform — Postgres schema (PG 15+)
-- Multi-tenant isolation via Row-Level Security. Every app connection MUST run:
--   SET app.tenant_id = '<uuid>';      (or SET LOCAL inside a transaction)
-- The app role is NOT the table owner and has no BYPASSRLS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS voice;
SET search_path = voice, public;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_key         text UNIQUE,                -- client_config.json client_id (onboarding upsert key)
  name               text NOT NULL,
  jurisdiction       text NOT NULL,              -- 'US', 'US-CA', 'EU-DE', 'CA', 'CA-QC', ...
  vapi_org_mode      text NOT NULL DEFAULT 'shared' CHECK (vapi_org_mode IN ('shared','dedicated')),
  vapi_assistant_id  text,                       -- single (or auto-detect multilingual) assistant
  vapi_squad_id      text,                       -- per-language squad; wins over vapi_assistant_id
  vapi_assistant_ids jsonb NOT NULL DEFAULT '{}', -- {"en-US": "asst_..", ...}, maintained by onboarding
  failover_number    text CHECK (failover_number ~ '^\+[1-9][0-9]{6,14}$'),
  outbound_vapi_phone_id text,                   -- caller ID for outbound jobs (must be one of this tenant's numbers)
  hipaa              boolean NOT NULL DEFAULT false,
  baa_verified_at    timestamptz,
  pia_completed_at   timestamptz,                -- Quebec Law 25 / DPIA evidence
  retention_days     int NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  recording_enabled  boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Activation gates: regulated tenants cannot go live without evidence.
  CONSTRAINT hipaa_needs_baa CHECK (NOT (hipaa AND status = 'active' AND baa_verified_at IS NULL)),
  CONSTRAINT qc_needs_pia    CHECK (NOT (jurisdiction = 'CA-QC' AND status = 'active' AND pia_completed_at IS NULL)),
  CONSTRAINT hipaa_no_recording CHECK (NOT (hipaa AND recording_enabled))
);

CREATE TABLE phone_numbers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  e164             text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  vapi_phone_id    text NOT NULL UNIQUE,         -- resolution key for inbound calls
  provider         text NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio','vonage','telnyx','vapi','sip')),
  line_type        text,
  max_concurrent_calls int NOT NULL DEFAULT 10 CHECK (max_concurrent_calls BETWEEN 1 AND 1000),
  stir_attestation text CHECK (stir_attestation IN ('A','B','C')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Contacts, consent, DNC (TCPA / CRTC / GDPR / PIPEDA)
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  e164         text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  timezone     text,                              -- IANA tz; NULL => dialer refuses
  region_code  text,                              -- 'US-FL', 'CA-ON', ...
  external_ref text,                              -- CRM/EHR id
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, e164)
);

CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  contact_id    uuid NOT NULL REFERENCES contacts(id),
  channel       text NOT NULL CHECK (channel IN ('voice_ai','sms','email')),
  purpose       text NOT NULL,                    -- 'appointment_reminders', 'marketing', ...
  consent_type  text NOT NULL CHECK (consent_type IN ('express','express_written','implied_ebr')),
  lawful_basis  text NOT NULL CHECK (lawful_basis IN ('consent','contract','legitimate_interest','legal_obligation')),
  evidence_uri  text NOT NULL,                    -- signed form / recording / web capture
  granted_at    timestamptz NOT NULL,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  UNIQUE (tenant_id, contact_id, channel, purpose)
);

-- Append-only history; consents rows are mutated only via revoke.
CREATE TABLE consent_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  consent_id  uuid NOT NULL REFERENCES consents(id),
  event       text NOT NULL CHECK (event IN ('granted','revoked','expired')),
  source      text NOT NULL,                      -- 'web_form', 'voice:request_opt_out', 'sms:STOP', ...
  vapi_call_id text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dnc_entries (
  tenant_id  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',  -- sentinel => global registry import
  e164       text NOT NULL,
  source     text NOT NULL CHECK (source IN ('internal','US_NDNC','CA_DNCL','state')),
  added_at   timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (e164, source, tenant_id)
);

CREATE TABLE calling_rules (
  region_code   text PRIMARY KEY,                 -- 'US', 'US-FL', 'CA', ...
  weekday_start time NOT NULL,
  weekday_end   time NOT NULL,
  weekend_start time,                             -- NULL => no weekend calls
  weekend_end   time,
  max_attempts_24h int
);
INSERT INTO calling_rules VALUES
  ('US',    '08:00', '21:00', '08:00', '21:00', NULL),
  ('US-FL', '08:00', '20:00', '08:00', '20:00', 3),
  ('CA',    '09:00', '21:30', '10:00', '18:00', NULL);
-- Extend per counsel's review; the dialer applies the strictest matching rule.

-- ---------------------------------------------------------------------------
-- Calls, per-call state, idempotency, DLQ, audit
-- ---------------------------------------------------------------------------
CREATE TABLE calls (
  vapi_call_id   text PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  contact_id     uuid REFERENCES contacts(id),
  direction      text NOT NULL CHECK (direction IN ('inbound','outbound')),
  status         text NOT NULL,
  ended_reason   text,
  started_at     timestamptz,
  ended_at       timestamptz,
  cost_usd       numeric(10,4),
  summary        text,
  transcript_enc bytea,                           -- pgp_sym_encrypt(transcript, key) ; key from KMS, not here
  purge_after    timestamptz                      -- set from tenants.retention_days
);

CREATE TABLE call_state (
  vapi_call_id      text PRIMARY KEY REFERENCES calls(vapi_call_id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL,
  identity_verified boolean NOT NULL DEFAULT false,
  verify_attempts   int NOT NULL DEFAULT 0 CHECK (verify_attempts <= 3),
  data              jsonb NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Concurrency leases. Acquired on assistant-request, released on status-update(ended) /
-- end-of-call-report. Leases expire so a lost "ended" event can't leak a slot forever.
CREATE TABLE active_calls (
  vapi_call_id     text PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  phone_number_id  uuid NOT NULL REFERENCES phone_numbers(id),
  caller_e164      text,                          -- NULL for withheld / anonymous callers
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL
);
CREATE INDEX ON active_calls (phone_number_id, lease_expires_at);
CREATE INDEX ON active_calls (phone_number_id, caller_e164);

CREATE TABLE idempotency_keys (
  key        text PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  response   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON idempotency_keys (created_at);    -- purge > 7 days

CREATE TABLE outbound_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  campaign_id     text NOT NULL,
  purpose         text NOT NULL,
  attempt_no      int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 3,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','dialing','completed','blocked','failed')),
  blocked_reason  text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  vapi_call_id    text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_due ON outbound_jobs (next_attempt_at) WHERE status = 'queued';

CREATE TABLE dead_letters (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid,
  workflow     text NOT NULL,
  node         text,
  error        text NOT NULL,
  payload      jsonb,                             -- REDACTED before insert
  retryable    boolean NOT NULL DEFAULT true,
  replayed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dsar_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  contact_id   uuid REFERENCES contacts(id),
  kind         text NOT NULL CHECK (kind IN ('access','erasure','rectification','portability')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','rejected')),
  due_at       timestamptz NOT NULL,              -- GDPR: 1 month; PIPEDA: 30 days
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid,
  table_name text NOT NULL,
  op         text NOT NULL,
  row_pk     text,
  actor      text NOT NULL DEFAULT current_user,
  at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit trigger (HIPAA §164.312(b)) — written by the DB, not app code
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record;
BEGIN
  r := COALESCE(NEW, OLD);
  INSERT INTO voice.audit_log (tenant_id, table_name, op, row_pk)
  VALUES ((to_jsonb(r)->>'tenant_id')::uuid, TG_TABLE_NAME, TG_OP,
          COALESCE(to_jsonb(r)->>'id', to_jsonb(r)->>'vapi_call_id'));
  RETURN NULL;
END $$;

CREATE TRIGGER audit_calls      AFTER INSERT OR UPDATE OR DELETE ON calls      FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_call_state AFTER INSERT OR UPDATE OR DELETE ON call_state FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_consents   AFTER INSERT OR UPDATE OR DELETE ON consents   FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_contacts   AFTER INSERT OR UPDATE OR DELETE ON contacts   FOR EACH ROW EXECUTE FUNCTION audit_row();

-- consent_events and audit_log are append-only for the app role.
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON consent_events FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER audit_log_append_only      BEFORE UPDATE OR DELETE ON audit_log      FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['phone_numbers','contacts','consents','consent_events','calls','active_calls',
                           'call_state','idempotency_keys','outbound_jobs','dsar_requests']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) '
                   'WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;

-- DNC: tenant sees its own entries plus global ones; can only write its own.
ALTER TABLE dnc_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE dnc_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY dnc_read  ON dnc_entries FOR SELECT
  USING (tenant_id IN (current_tenant(), '00000000-0000-0000-0000-000000000000'));
CREATE POLICY dnc_write ON dnc_entries FOR INSERT WITH CHECK (tenant_id = current_tenant());

-- Inbound tenant resolution happens before a tenant is known: expose a narrow
-- SECURITY DEFINER lookup instead of granting the edge role access to phone_numbers.
CREATE OR REPLACE FUNCTION resolve_tenant_by_vapi_phone(p_vapi_phone_id text)
RETURNS TABLE (tenant_id uuid, hipaa boolean, jurisdiction text, vapi_assistant_id text,
               vapi_squad_id text, failover_number text, max_concurrent_calls int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = voice AS $$
  SELECT t.id, t.hipaa, t.jurisdiction, t.vapi_assistant_id,
         t.vapi_squad_id, t.failover_number, p.max_concurrent_calls
  FROM phone_numbers p JOIN tenants t ON t.id = p.tenant_id
  WHERE p.vapi_phone_id = p_vapi_phone_id AND t.status = 'active'
$$;

-- ---------------------------------------------------------------------------
-- Dial-time compliance gate (single source of truth; dialer calls this)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_dial(p_contact uuid, p_purpose text, p_at timestamptz DEFAULT now())
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c        contacts%ROWTYPE;
  local_ts timestamp;
  is_wkend boolean;
  r        calling_rules%ROWTYPE;
  win_start time;
  win_end   time;
BEGIN
  SELECT * INTO c FROM contacts WHERE id = p_contact;          -- RLS-scoped
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'contact_not_found'; RETURN; END IF;
  IF c.timezone IS NULL THEN RETURN QUERY SELECT false, 'unknown_timezone'; RETURN; END IF;

  IF EXISTS (SELECT 1 FROM dnc_entries d WHERE d.e164 = c.e164
             AND (d.expires_at IS NULL OR d.expires_at > p_at)) THEN
    RETURN QUERY SELECT false, 'dnc'; RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM consents k WHERE k.contact_id = c.id AND k.channel = 'voice_ai'
                 AND k.purpose = p_purpose AND k.revoked_at IS NULL
                 AND (k.expires_at IS NULL OR k.expires_at > p_at)
                 AND (p_purpose <> 'marketing' OR k.consent_type = 'express_written')) THEN
    RETURN QUERY SELECT false, 'no_valid_consent'; RETURN;
  END IF;

  local_ts := p_at AT TIME ZONE c.timezone;
  is_wkend := extract(isodow FROM local_ts) IN (6, 7);

  -- Strictest applicable rule: country first, then region overrides narrow it.
  FOR r IN SELECT * FROM calling_rules
           WHERE region_code = split_part(COALESCE(c.region_code, ''), '-', 1)
              OR region_code = c.region_code
  LOOP
    IF is_wkend AND r.weekend_start IS NULL THEN
      RETURN QUERY SELECT false, 'weekend_blocked:' || r.region_code; RETURN;
    END IF;
    win_start := CASE WHEN is_wkend THEN r.weekend_start ELSE r.weekday_start END;
    win_end   := CASE WHEN is_wkend THEN r.weekend_end   ELSE r.weekday_end   END;
    IF local_ts::time < win_start OR local_ts::time >= win_end THEN
      RETURN QUERY SELECT false, 'outside_hours:' || r.region_code; RETURN;
    END IF;
  END LOOP;

  IF NOT FOUND THEN                                  -- no rule covers this region: fail closed
    RETURN QUERY SELECT false, 'unknown_region'; RETURN;
  END IF;

  RETURN QUERY SELECT true, 'ok';
END $$;

-- ---------------------------------------------------------------------------
-- n8n entry points
-- n8n's Postgres node pools connections, so a separate `SET app.tenant_id` may
-- land on a different connection than the next query. These functions set the
-- tenant transaction-locally and do the work in one round trip. RLS here guards
-- against bugs (a forgotten WHERE), not against a compromised app role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_tenant(p_tenant uuid) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('app.tenant_id', p_tenant::text, true) $$;

-- Fair, cross-tenant claim of due outbound jobs: at most p_per_tenant per tenant per tick.
CREATE OR REPLACE FUNCTION claim_outbound_jobs(p_per_tenant int DEFAULT 10)
RETURNS SETOF outbound_jobs LANGUAGE plpgsql AS $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE status = 'active' LOOP
    PERFORM set_tenant(t);
    RETURN QUERY
      UPDATE outbound_jobs j
      SET status = 'dialing', attempt_no = j.attempt_no + 1, updated_at = now()
      WHERE j.id IN (SELECT q.id FROM outbound_jobs q
                     WHERE q.status = 'queued' AND q.next_attempt_at <= now()
                     ORDER BY q.next_attempt_at LIMIT p_per_tenant
                     FOR UPDATE SKIP LOCKED)
      RETURNING j.*;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION can_dial_for(p_tenant uuid, p_contact uuid, p_purpose text)
RETURNS TABLE (allowed boolean, reason text, e164 text) LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_tenant(p_tenant);
  RETURN QUERY SELECT g.allowed, g.reason, c.e164
               FROM can_dial(p_contact, p_purpose) g, contacts c WHERE c.id = p_contact;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'contact_not_found'::text, NULL::text; END IF;
END $$;

-- Outcome of a dial attempt. Outside-hours blocks are rescheduled, not dropped.
CREATE OR REPLACE FUNCTION finish_outbound_job(p_tenant uuid, p_job uuid, p_outcome text,
                                               p_reason text DEFAULT NULL, p_vapi_call_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_tenant(p_tenant);
  UPDATE outbound_jobs SET
    vapi_call_id   = COALESCE(p_vapi_call_id, vapi_call_id),
    blocked_reason = p_reason,
    updated_at     = now(),
    status = CASE
      WHEN p_outcome = 'dialed' THEN 'completed'
      WHEN p_outcome = 'blocked' AND p_reason LIKE 'outside_hours:%' THEN 'queued'
      WHEN p_outcome = 'blocked' THEN 'blocked'
      WHEN p_outcome = 'error' AND attempt_no < max_attempts THEN 'queued'
      ELSE 'failed' END,
    next_attempt_at = CASE
      WHEN p_outcome = 'blocked' AND p_reason LIKE 'outside_hours:%' THEN now() + interval '30 minutes'
      WHEN p_outcome = 'error' THEN now() + (interval '2 minutes' * power(2, attempt_no))
      ELSE next_attempt_at END
  WHERE id = p_job;
END $$;

-- Idempotent ingest of VAPI end-of-call-report / status-update. Returns false on duplicate.
CREATE OR REPLACE FUNCTION record_call_event(p_tenant uuid, p_idem_key text, p_call jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE claimed text; ret int;
BEGIN
  PERFORM set_tenant(p_tenant);
  INSERT INTO idempotency_keys (key, tenant_id) VALUES (p_idem_key, p_tenant)
  ON CONFLICT (key) DO NOTHING RETURNING key INTO claimed;
  IF claimed IS NULL THEN RETURN false; END IF;

  SELECT retention_days INTO ret FROM tenants WHERE id = p_tenant;
  INSERT INTO calls (vapi_call_id, tenant_id, direction, status, ended_reason, started_at, ended_at, cost_usd, summary, purge_after)
  VALUES (p_call->>'id', p_tenant, COALESCE(p_call->>'direction', 'inbound'), p_call->>'status',
          p_call->>'endedReason', (p_call->>'startedAt')::timestamptz, (p_call->>'endedAt')::timestamptz,
          (p_call->>'cost')::numeric, p_call->>'summary', now() + make_interval(days => ret))
  ON CONFLICT (vapi_call_id) DO UPDATE SET
    status       = EXCLUDED.status,
    ended_reason = COALESCE(EXCLUDED.ended_reason, calls.ended_reason),
    started_at   = COALESCE(EXCLUDED.started_at, calls.started_at),
    ended_at     = COALESCE(EXCLUDED.ended_at, calls.ended_at),
    cost_usd     = COALESCE(EXCLUDED.cost_usd, calls.cost_usd),
    summary      = COALESCE(EXCLUDED.summary, calls.summary),
    purge_after  = EXCLUDED.purge_after;
  RETURN true;
END $$;

-- Onboarding pre-flight: who owns this number? (phone_numbers is RLS-scoped, so a
-- tenant can't see a conflicting owner; an upsert would silently no-op instead of failing.)
CREATE OR REPLACE FUNCTION phone_number_owner(p_e164 text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT tenant_id FROM phone_numbers WHERE e164 = p_e164 $$;

-- Per-number concurrency gate. The advisory lock serialises acquirers for one number, so
-- N simultaneous inbound calls can never all see "max-1 active" and all get in.
-- Also caps concurrent calls from ONE caller number, so a robocaller or a redial loop
-- can't take every slot from real customers. Idempotent per call id (VAPI may resend).
CREATE OR REPLACE FUNCTION acquire_call_slot(p_vapi_phone_id text, p_vapi_call_id text,
                                             p_lease_seconds int DEFAULT 1020,
                                             p_caller text DEFAULT NULL, p_max_per_caller int DEFAULT 2)
RETURNS TABLE (granted boolean, active int, max_allowed int, reason text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE pn phone_numbers%ROWTYPE; n int; from_caller int;
BEGIN
  SELECT * INTO pn FROM phone_numbers WHERE vapi_phone_id = p_vapi_phone_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 0, 0, 'unknown_number'; RETURN; END IF;
  PERFORM set_tenant(pn.tenant_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(pn.id::text, 0));

  IF EXISTS (SELECT 1 FROM active_calls WHERE vapi_call_id = p_vapi_call_id) THEN
    SELECT count(*) INTO n FROM active_calls WHERE phone_number_id = pn.id;
    RETURN QUERY SELECT true, n, pn.max_concurrent_calls, 'ok'; RETURN;
  END IF;

  DELETE FROM active_calls WHERE phone_number_id = pn.id AND lease_expires_at < now();

  IF p_caller IS NOT NULL THEN
    SELECT count(*) INTO from_caller FROM active_calls WHERE phone_number_id = pn.id AND caller_e164 = p_caller;
    IF from_caller >= p_max_per_caller THEN
      RETURN QUERY SELECT false, from_caller, p_max_per_caller, 'caller_limit'; RETURN;
    END IF;
  END IF;

  SELECT count(*) INTO n FROM active_calls WHERE phone_number_id = pn.id;
  IF n >= pn.max_concurrent_calls THEN
    RETURN QUERY SELECT false, n, pn.max_concurrent_calls, 'at_capacity'; RETURN;
  END IF;

  INSERT INTO active_calls (vapi_call_id, tenant_id, phone_number_id, caller_e164, lease_expires_at)
  VALUES (p_vapi_call_id, pn.tenant_id, pn.id, p_caller, now() + make_interval(secs => p_lease_seconds));
  RETURN QUERY SELECT true, n + 1, pn.max_concurrent_calls, 'ok';
END $$;

-- Inbound callback request = the caller's express consent to be called back at that number
-- for that purpose. Evidence is the call itself. Re-grants a previously revoked consent
-- (an explicit new request supersedes an earlier opt-out for this purpose only; the DNC
-- entry is NOT removed here, so callbacks still go through a human review of DNC hits).
CREATE OR REPLACE FUNCTION record_callback_consent(p_tenant uuid, p_caller text, p_vapi_call_id text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE cid uuid; kid uuid;
BEGIN
  PERFORM set_tenant(p_tenant);
  INSERT INTO contacts (tenant_id, e164) VALUES (p_tenant, p_caller)
  ON CONFLICT (tenant_id, e164) DO UPDATE SET e164 = EXCLUDED.e164
  RETURNING id INTO cid;
  INSERT INTO consents (tenant_id, contact_id, channel, purpose, consent_type, lawful_basis, evidence_uri, granted_at)
  VALUES (p_tenant, cid, 'voice_ai', 'callback', 'express', 'consent', 'vapi:call/' || p_vapi_call_id, now())
  ON CONFLICT (tenant_id, contact_id, channel, purpose) DO UPDATE
    SET evidence_uri = EXCLUDED.evidence_uri, granted_at = now(), revoked_at = NULL,
        expires_at = now() + interval '30 days'
  RETURNING id INTO kid;
  UPDATE consents SET expires_at = now() + interval '30 days' WHERE id = kid AND expires_at IS NULL;
  INSERT INTO consent_events (tenant_id, consent_id, event, source, vapi_call_id)
  VALUES (p_tenant, kid, 'granted', 'voice:log_callback_request', p_vapi_call_id);
  RETURN kid;
END $$;

CREATE OR REPLACE FUNCTION release_call_slot(p_vapi_call_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t uuid;
BEGIN
  SELECT tenant_id INTO t FROM active_calls WHERE vapi_call_id = p_vapi_call_id;
  IF t IS NULL THEN RETURN false; END IF;
  PERFORM set_tenant(t);
  DELETE FROM active_calls WHERE vapi_call_id = p_vapi_call_id;
  RETURN true;
END $$;

-- Pin search_path on every function: callers (n8n, edge) won't have `voice` on theirs,
-- and an unpinned path on a SECURITY DEFINER function is a hijack vector.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'voice'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = voice, public', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- Run this file as voice_owner (owns all objects). voice_owner needs BYPASSRLS because
-- FORCE RLS also applies to table owners, and the SECURITY DEFINER lookups
-- (resolve_tenant_by_vapi_phone, acquire/release_call_slot) run before a tenant is known.
-- CREATE ROLE voice_owner NOLOGIN BYPASSRLS;
-- CREATE ROLE voice_app LOGIN PASSWORD '...';     -- edge + n8n; NO BYPASSRLS
-- GRANT USAGE ON SCHEMA voice TO voice_app;
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA voice TO voice_app;
-- GRANT INSERT ON dead_letters, audit_log TO voice_app;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA voice TO voice_app;
-- REVOKE DELETE ON ALL TABLES IN SCHEMA voice FROM voice_app;   -- purges run as a separate job role
