// A visitor's session is a random token in an httpOnly cookie. The token opens one profile on the MCP server.
// The public demo deletes idle profiles after a day.
import { openProfile } from "./mcp.server";

const COOKIE = "alsxa_session";
const MAX_AGE_SECONDS = 24 * 3600;

export function readToken(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const value = rest.join("=");
      return /^als_[0-9a-f]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

function secure(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return proto === "https" ? "; Secure" : "";
}

export function setCookie(request: Request, token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure(request)}`;
}

export function clearCookie(request: Request): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(request)}`;
}

/** The visitor's token, opening a new profile if there is none. `fresh` is set when a cookie must be sent. */
export async function ensureSession(request: Request): Promise<{ token: string; fresh: boolean }> {
  const existing = readToken(request);
  if (existing) return { token: existing, fresh: false };
  return { token: await openProfile(), fresh: true };
}
