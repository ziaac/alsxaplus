// The HTTP side: /mcp for assistants (MCP 2025-11-25, Streamable HTTP), /api/me for the person's own app actions,
// and /internal for the web app that opens a profile for a visitor.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { authenticate, createProfile } from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { deleteEverything, type Deps, forgetPhrase, getStatus, listPhrases, ServiceError, setConsent } from "./service.js";

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildApp(deps: Deps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await deps.db.query("SELECT 1");
      res.json({ status: "ok", database: "up" });
    } catch (error) {
      console.error("[health] the database query failed:", (error as Error).message);
      res.status(503).json({ status: "degraded", database: "down" });
    }
  });

  // Only the web app, which knows the service key, can open a profile.
  app.post("/internal/profiles", async (req, res, next) => {
    try {
      if (!sameSecret(String(req.header("x-service-key") ?? ""), deps.config.serviceKey)) {
        console.warn("[internal] a request without the right service key was refused");
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const { profileId, token } = await createProfile(deps.db);
      console.info(`[internal] profile ${profileId} opened`);
      res.status(201).json({ profile_id: profileId, token });
    } catch (error) {
      next(error);
    }
  });

  const hostAllowed = (req: Request, res: Response, next: NextFunction) => {
    let host = "";
    try {
      host = new URL(`http://${req.headers.host ?? ""}`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      // an unreadable Host header is refused below
    }
    if (!deps.config.allowedHosts.includes(host)) {
      console.warn(`[mcp] request refused: host '${host}' is not allowed`);
      res.status(403).json({ error: "forbidden_host" });
      return;
    }
    next();
  };

  // No WWW-Authenticate header on a 401, as the Alexa+ documentation asks.
  const auth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const profileId = token ? await authenticate(deps.db, token) : null;
      if (!profileId) {
        console.warn(`[auth] ${req.method} ${req.path} refused: token missing, unknown or expired`);
        res.status(401).json({ error: "unauthorized", message: "A valid bearer token is required." });
        return;
      }
      res.locals.profileId = profileId;
      next();
    } catch (error) {
      next(error);
    }
  };

  const profile = (res: Response): string => res.locals.profileId as string;

  // The person's own actions: consent and deleting data are here, not in the assistant's tools.
  app.get("/api/me", auth, async (_req, res, next) => {
    try {
      res.json(await getStatus(deps.db, profile(res)));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/me/consent", auth, async (req, res, next) => {
    try {
      if (typeof req.body?.given !== "boolean") throw new ServiceError("invalid_argument", "given must be true or false.", 400);
      res.json(await setConsent(deps.db, profile(res), req.body.given));
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/me/phrases", auth, async (_req, res, next) => {
    try {
      res.json({ phrases: await listPhrases(deps.db, profile(res), 100) });
    } catch (e) {
      next(e);
    }
  });
  app.delete("/api/me/phrases", auth, async (req, res, next) => {
    try {
      if (typeof req.body?.text !== "string" || !req.body.text) throw new ServiceError("invalid_argument", "text is required.", 400);
      res.json(await forgetPhrase(deps.db, profile(res), req.body.text));
    } catch (e) {
      next(e);
    }
  });
  app.delete("/api/me", auth, async (_req, res, next) => {
    try {
      const id = profile(res);
      const out = await deleteEverything(deps.db, id);
      console.info(`[api] profile ${id} deleted by its owner`);
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // Stateless Streamable HTTP: a fresh server and transport for every request, bound to the person's token.
  app.post("/mcp", hostAllowed, auth, async (req, res, next) => {
    try {
      const server = createMcpServer(deps, profile(res));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error("[http] request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "server_error", message: "Something went wrong on our side." });
  });

  return app;
}
