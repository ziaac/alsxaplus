// The server through the official MCP TypeScript client, against a real database. Runs when TEST_DATABASE_URL is set
// (mcp/.env has it for local work). The model is not configured here, so the rules rank the suggestions.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { connect, type Db, migrate } from "../src/db.js";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // the variables may come from the environment
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const SERVICE_KEY = "test-service-key-0123456789";

describe.skipIf(!databaseUrl)("through the official MCP client", () => {
  let db: Db;
  let server: Server;
  let base: string;
  const tokens: string[] = [];

  beforeAll(async () => {
    db = connect(databaseUrl!);
    await migrate(db);
    const config: Config = { databaseUrl: databaseUrl!, port: 0, serviceKey: SERVICE_KEY, profileTtlHours: 24, allowedHosts: ["localhost", "127.0.0.1", "::1"], bedrock: null };
    server = buildApp({ db, config }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const t of tokens) await fetch(`${base}/api/me`, { method: "DELETE", headers: { authorization: `Bearer ${t}` } });
    await new Promise((r) => server.close(r));
    await db.end();
  });

  async function openProfile(): Promise<string> {
    const res = await fetch(`${base}/internal/profiles`, { method: "POST", headers: { "x-service-key": SERVICE_KEY } });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    tokens.push(token);
    return token;
  }

  async function connectClient(token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(transport);
    return { client, transport };
  }

  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), s: (r.structuredContent ?? {}) as any };
  };

  const consent = (token: string) => fetch(`${base}/api/me/consent`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ given: true }) });

  it("speaks MCP 2025-11-25 over Streamable HTTP and lists the tools", async () => {
    const { client, transport } = await connectClient(await openProfile());
    expect(transport.protocolVersion).toBe("2025-11-25");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["confirm_meaning", "get_status", "list_my_phrases", "set_speech_support", "suggest_meanings"]);
    await client.close();
  });

  it("needs consent first, asks the speech question once, and then suggests", async () => {
    const token = await openProfile();
    const { client } = await connectClient(token);

    let r = await call(client, "suggest_meanings", { heard: [{ text: "wa er" }] });
    expect(r.isError).toBe(true);
    expect(r.s.error.code).toBe("consent_required");

    expect((await consent(token)).status).toBe(200);

    r = await call(client, "suggest_meanings", { heard: [{ text: "wa er" }] });
    expect(r.s.status).toBe("needs_speech_support_answer");
    expect((await call(client, "get_status")).s.speech_support).toBeNull();

    r = await call(client, "set_speech_support", { enabled: true });
    expect(r.s.speech_support).toBe(true);

    r = await call(client, "suggest_meanings", { heard: [{ text: "wa er", confidence: 0.4 }] });
    expect(r.s.status).toBe("ok");
    expect(r.s.options).toHaveLength(6);
    expect(r.s.recommended).toBe(r.s.options[0].text);
    expect(r.s.others).toHaveLength(5);
    expect(r.s.source).toBe("rule");
    await client.close();
  });

  it("learns what a person's sounds mean, and keeps it to that person", async () => {
    const tokenA = await openProfile();
    const tokenB = await openProfile();
    await consent(tokenA);
    await consent(tokenB);
    const a = (await connectClient(tokenA)).client;
    const b = (await connectClient(tokenB)).client;
    await call(a, "set_speech_support", { enabled: true });
    await call(b, "set_speech_support", { enabled: true });

    // The first time, "uh oh ee" is a guess. The person types what they meant.
    const first = (await call(a, "suggest_meanings", { heard: [{ text: "uh oh ee", confidence: 0.3 }] })).s;
    const typed = await call(a, "confirm_meaning", { utterance_id: first.utterance_id, typed_text: "Please bring me a blanket" });
    expect(typed.s).toMatchObject({ text: "Please bring me a blanket", kind: "typed", uses: 1, learned_sounds: 1 });

    // The same sounds later: that sentence is now the recommended one.
    const second = (await call(a, "suggest_meanings", { heard: [{ text: "uh oh ee", confidence: 0.3 }] })).s;
    expect(second.recommended).toBe("Please bring me a blanket");
    const again = await call(a, "confirm_meaning", { utterance_id: second.utterance_id, option: 0 });
    expect(again.s).toMatchObject({ kind: "suggested", uses: 2 });

    // Another person with the same sounds learned nothing from this.
    const other = (await call(b, "suggest_meanings", { heard: [{ text: "uh oh ee", confidence: 0.3 }] })).s;
    expect(other.options.map((o: any) => o.text)).not.toContain("Please bring me a blanket");
    expect((await call(b, "list_my_phrases")).s.phrases).toEqual([]);
    expect((await call(a, "list_my_phrases")).s.phrases[0]).toEqual({ text: "Please bring me a blanket", uses: 2 });
    await a.close();
    await b.close();
  });

  it("confirms the same suggestion only once, and rejects bad input with a readable error", async () => {
    const token = await openProfile();
    await consent(token);
    const { client } = await connectClient(token);
    await call(client, "set_speech_support", { enabled: true });
    const s = (await call(client, "suggest_meanings", { heard: [{ text: "i thirsty" }] })).s;

    const one = await call(client, "confirm_meaning", { utterance_id: s.utterance_id, option: 1 });
    expect(one.s.already_confirmed).toBe(false);
    const two = await call(client, "confirm_meaning", { utterance_id: s.utterance_id, option: 3 });
    expect(two.s).toMatchObject({ already_confirmed: true, text: one.s.text });

    const fresh = (await call(client, "suggest_meanings", { heard: [{ text: "hello" }] })).s;
    for (const bad of [{ utterance_id: fresh.utterance_id }, { utterance_id: fresh.utterance_id, option: 1, typed_text: "x" }, { utterance_id: "not-an-id", option: 1 }, { utterance_id: "00000000-0000-4000-8000-000000000000", option: 1 }]) {
      const r = await call(client, "confirm_meaning", bad);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
    const none = await call(client, "suggest_meanings", { heard: [] });
    expect(none.s.heard_nothing).toBe(true);
    expect(none.s.options).toHaveLength(6);
    await client.close();
  });

  it("answers no to the speech question and gets no suggestions until it is turned on", async () => {
    const token = await openProfile();
    await consent(token);
    const { client } = await connectClient(token);
    await call(client, "set_speech_support", { enabled: false });
    expect((await call(client, "suggest_meanings", { heard: [{ text: "hello" }] })).s.status).toBe("speech_support_off");
    await call(client, "set_speech_support", { enabled: true });
    expect((await call(client, "suggest_meanings", { heard: [{ text: "hello" }] })).s.status).toBe("ok");
    await client.close();
  });

  it("deletes everything on request and the token stops working", async () => {
    const token = await openProfile();
    await consent(token);
    const { client } = await connectClient(token);
    await call(client, "set_speech_support", { enabled: true });
    const s = (await call(client, "suggest_meanings", { heard: [{ text: "hello there" }] })).s;
    await call(client, "confirm_meaning", { utterance_id: s.utterance_id, option: 0 });
    await client.close();

    const del = await fetch(`${base}/api/me`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    const after = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
  });

  it("keeps consent and deleting data out of the assistant's tools", async () => {
    const { client } = await connectClient(await openProfile());
    const names = (await client.listTools()).tools.map((t) => t.name.toLowerCase());
    expect(names.filter((n) => /consent|delete|erase|forget/.test(n))).toEqual([]);
    await client.close();
  });

  it("refuses a request without a token, a wrong service key, and a Host that is not allowed", async () => {
    const noToken = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toBeNull();
    const wrongKey = await fetch(`${base}/internal/profiles`, { method: "POST", headers: { "x-service-key": "nope" } });
    expect(wrongKey.status).toBe(401);

    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/mcp`);
      const req = httpRequest({ host: url.hostname, port: url.port, path: "/mcp", method: "POST", headers: { host: "evil.example", "content-type": "application/json", authorization: `Bearer ${tokens[0]}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });
});
