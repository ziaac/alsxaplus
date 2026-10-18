import pg from "pg";

export type Db = pg.Pool;

export function connect(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 10_000 });
  pool.on("error", (error) => console.error("[db] idle client error:", error.message));
  return pool;
}

// Each migration runs once, in order, inside one transaction.
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  consented_at   timestamptz,
  -- NULL means the person has not been asked yet. The question is asked once.
  speech_support boolean
);

CREATE TABLE access_tokens (
  token_hash bytea PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX access_tokens_profile_idx ON access_tokens (profile_id);

-- What the recogniser heard and what was offered. Audio is never stored.
CREATE TABLE utterances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  heard           jsonb NOT NULL,
  candidates      jsonb NOT NULL,
  source          text NOT NULL CHECK (source IN ('agent', 'rule')),
  fallback_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX utterances_profile_idx ON utterances (profile_id, created_at DESC);

-- What the person chose or typed. This is what the app learns from.
CREATE TABLE confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id uuid NOT NULL UNIQUE REFERENCES utterances (id) ON DELETE CASCADE,
  profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  text         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('suggested', 'alternative', 'typed')),
  rank         smallint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX confirmations_profile_idx ON confirmations (profile_id, created_at DESC);

-- The person's own sentences, with how often they were confirmed.
CREATE TABLE phrases (
  profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  text         text NOT NULL,
  uses         integer NOT NULL DEFAULT 1 CHECK (uses >= 1),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, text)
);

-- How this person's speech is usually written down by the recogniser, and what it turned out to mean:
-- "wa er" was confirmed as "I need water". This is the main thing the app learns.
CREATE TABLE aliases (
  profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  heard        text NOT NULL,
  text         text NOT NULL,
  uses         integer NOT NULL DEFAULT 1 CHECK (uses >= 1),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, heard, text)
);

-- Every model call, with an estimated cost. The monthly limit is checked against this table.
-- It holds no text from people: only token counts, cost, outcome and timing.
CREATE TABLE model_usage (
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
CREATE INDEX model_usage_month_idx ON model_usage (created_at);
`,
  },
];

export async function migrate(db: Db): Promise<void> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const m of MIGRATIONS) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // A lock keeps two starting copies from running the same migration together.
      await client.query("SELECT pg_advisory_xact_lock(7102026)");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [m.id]);
      if (done.rowCount === 0) {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        console.info(`[db] migration ${m.id} applied`);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${m.id} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
}
