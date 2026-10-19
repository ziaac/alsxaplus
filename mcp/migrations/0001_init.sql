-- Written to be safe on a database that already has these tables (a copy made before migrations were tracked here).
CREATE TABLE IF NOT EXISTS profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  consented_at   timestamptz,
  -- NULL means the person has not been asked yet. The question is asked once.
  speech_support boolean
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash bytea PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS access_tokens_profile_idx ON access_tokens (profile_id);

-- What the recogniser heard and what was offered. Audio is never stored.
CREATE TABLE IF NOT EXISTS utterances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  heard           jsonb NOT NULL,
  candidates      jsonb NOT NULL,
  source          text NOT NULL CHECK (source IN ('agent', 'rule')),
  fallback_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS utterances_profile_idx ON utterances (profile_id, created_at DESC);

-- What the person chose or typed. This is what the app learns from.
CREATE TABLE IF NOT EXISTS confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id uuid NOT NULL UNIQUE REFERENCES utterances (id) ON DELETE CASCADE,
  profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  text         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('suggested', 'alternative', 'typed')),
  rank         smallint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confirmations_profile_idx ON confirmations (profile_id, created_at DESC);

-- The person's own sentences, with how often they were confirmed.
CREATE TABLE IF NOT EXISTS phrases (
  profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  text         text NOT NULL,
  uses         integer NOT NULL DEFAULT 1 CHECK (uses >= 1),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, text)
);

-- How this person's speech is usually written down by the recogniser, and what it turned out to mean:
-- "wa er" was confirmed as "I need water". This is the main thing the app learns.
CREATE TABLE IF NOT EXISTS aliases (
  profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  heard        text NOT NULL,
  text         text NOT NULL,
  uses         integer NOT NULL DEFAULT 1 CHECK (uses >= 1),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, heard, text)
);

-- Every model call, with an estimated cost. The monthly limit is checked against this table.
-- It holds no text from people: only token counts, cost, outcome and timing.
CREATE TABLE IF NOT EXISTS model_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid REFERENCES profiles (id) ON DELETE SET NULL,
  purpose       text NOT NULL,
  model_id      text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (estimated_usd >= 0),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'invalid_output', 'policy_violation', 'error')),
  detail        text,
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_usage_month_idx ON model_usage (created_at);
