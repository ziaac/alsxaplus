// Access tokens. A token belongs to one profile, is random, is shown once, and is stored only as a SHA-256 hash.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

const TOKEN_DAYS = 30;

/** Opens a profile and returns its first token. The token is returned only here. */
export async function createProfile(db: Db): Promise<{ profileId: string; token: string }> {
  const token = `als_${randomBytes(32).toString("hex")}`;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const p = await client.query("INSERT INTO profiles DEFAULT VALUES RETURNING id");
    const profileId = String(p.rows[0].id);
    await client.query("INSERT INTO access_tokens (token_hash, profile_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [
      hashToken(token),
      profileId,
      TOKEN_DAYS,
    ]);
    await client.query("COMMIT");
    // Read back: the token must open the profile that was just made.
    const back = await authenticate(db, token);
    if (back !== profileId) throw new Error("the new token does not open the new profile");
    return { profileId, token };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The profile a token opens, or null if the token is unknown or has expired. Using a token counts as being seen. */
export async function authenticate(db: Db, token: string): Promise<string | null> {
  if (!/^als_[0-9a-f]{64}$/.test(token)) return null;
  const r = await db.query(
    `UPDATE profiles p SET last_seen_at = now()
     FROM access_tokens t
     WHERE t.profile_id = p.id AND t.token_hash = $1 AND t.expires_at > now()
     RETURNING p.id`,
    [hashToken(token)],
  );
  return r.rows[0] ? String(r.rows[0].id) : null;
}
