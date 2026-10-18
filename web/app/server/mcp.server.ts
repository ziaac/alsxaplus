// Talks to the ALSxaPlus MCP server on behalf of one visitor. The visitor's token lives in an httpOnly cookie and is
// added here, so the browser never holds it. The assistant tools go through MCP (2025-11-25, Streamable HTTP);
// consent, listing and deleting are plain REST calls, because a voice assistant must never do those.
import { env, requiredEnv } from "./env.server";

const PROTOCOL = "2025-11-25";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 300;

export class McpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const base = () => (env("MCP_URL") ?? "http://127.0.0.1:8081").replace(/\/$/, "");

async function send(path: string, init: RequestInit & { token?: string }, what: string): Promise<Response> {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
      if (init.token) headers.authorization = `Bearer ${init.token}`;
      const res = await fetch(`${base()}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
      // Only a busy or restarting server is worth another try.
      if ([502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
        console.warn(`[mcp] ${what}: HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} after ${BACKOFF_MS * attempt} ms`);
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
        continue;
      }
      return res;
    } catch (error) {
      lastError = (error as Error).message;
      console.warn(`[mcp] ${what}: request failed (${lastError}), attempt ${attempt}/${MAX_ATTEMPTS}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
    }
  }
  console.error(`[mcp] ${what}: giving up: ${lastError}`);
  throw new McpError("The sentence service could not be reached. Try again in a moment.", 502);
}

/** Opens a profile for a new visitor and returns its token. Only this server knows the service key. */
export async function openProfile(): Promise<string> {
  const res = await send("/internal/profiles", { method: "POST", headers: { "x-service-key": requiredEnv("SERVICE_KEY") } }, "open profile");
  if (!res.ok) {
    console.error(`[mcp] opening a profile failed: HTTP ${res.status}`);
    throw new McpError("Could not start a session.", 502);
  }
  return String(((await res.json()) as { token: string }).token);
}

function parseBody(contentType: string, text: string): any {
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = data.at(-1);
    if (!last) throw new McpError("the MCP server sent an event stream without data", 502);
    return JSON.parse(last);
  }
  return JSON.parse(text);
}

/** Calls one tool. Returns the tool's structured result, or throws McpError with the tool's own code and message. */
export async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await send(
    "/mcp",
    {
      method: "POST",
      token,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    },
    `tool ${name}`,
  );
  if (res.status === 401) throw new McpError("The session has ended.", 401, "unauthorized");
  const text = await res.text();
  let json: any;
  try {
    json = parseBody(res.headers.get("content-type") ?? "", text);
  } catch (error) {
    console.error(`[mcp] ${name}: unreadable answer (HTTP ${res.status}): ${text.slice(0, 120)}`);
    throw new McpError("The sentence service gave an answer that could not be read.", 502);
  }
  if (json?.error) throw new McpError(String(json.error.message ?? "the MCP server refused the request"), 502);
  const result = json?.result;
  if (result?.isError) {
    const e = result.structuredContent?.error;
    throw new McpError(String(e?.message ?? result.content?.[0]?.text ?? "The request was refused."), e?.code === "consent_required" ? 403 : 400, e?.code);
  }
  return result?.structuredContent ?? {};
}

/** The person's own actions: status, consent, sentences, delete. Not tools. */
export async function rest(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await send(path, { method, token, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, `${method} ${path}`);
  if (res.status === 401) throw new McpError("The session has ended.", 401, "unauthorized");
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new McpError(String(json?.message ?? `the server answered HTTP ${res.status}`), res.status, json?.error);
  return json;
}
