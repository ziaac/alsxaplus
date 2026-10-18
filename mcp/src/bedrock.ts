// Amazon Bedrock through the Converse API with a Bedrock API key. The model must answer by calling one tool, which
// is the reliable way to get one JSON object back. Model id, region, prices and limits all come from the environment.
import type { BedrockSettings } from "./config.js";

export interface ModelRequest {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  maxTokens: number;
}

export interface ModelReply {
  toolInput: unknown;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** `transient` failures (timeouts, throttling, service trouble) are worth another try. The rest are not. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

export function buildBody(request: ModelRequest): Record<string, unknown> {
  return {
    system: [{ text: request.system }],
    messages: [{ role: "user", content: [{ text: request.user }] }],
    inferenceConfig: { maxTokens: request.maxTokens },
    toolConfig: {
      tools: [{ toolSpec: { name: request.toolName, description: request.toolDescription, inputSchema: { json: request.toolSchema } } }],
      toolChoice: { tool: { name: request.toolName } },
    },
    // A small ranking task: thinking is off and effort is low.
    additionalModelRequestFields: { thinking: { type: "disabled" }, output_config: { effort: "low" } },
  };
}

export const isTransientStatus = (status: number): boolean => [408, 429, 500, 502, 503, 504, 529].includes(status);

export function parseResponse(body: any, toolName: string, fallbackLatencyMs: number): ModelReply {
  const blocks: any[] = Array.isArray(body?.output?.message?.content) ? body.output.message.content : [];
  const use = blocks.map((b) => b?.toolUse).find((t) => t?.name === toolName);
  if (!use) throw new ModelError(`the model did not call the tool (stopReason ${body?.stopReason ?? "unknown"})`, false);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return {
    toolInput: use.input,
    inputTokens: n(body?.usage?.inputTokens),
    outputTokens: n(body?.usage?.outputTokens),
    latencyMs: n(body?.metrics?.latencyMs) || fallbackLatencyMs,
  };
}

async function once(settings: BedrockSettings, request: ModelRequest): Promise<ModelReply> {
  const started = Date.now();
  const url = `https://bedrock-runtime.${settings.region}.amazonaws.com/model/${encodeURIComponent(settings.modelId)}/converse`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(buildBody(request)),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    // The error text never holds the key (it is in a header that is not part of the message).
    const e = error as Error;
    throw new ModelError(`the request failed: ${e.name === "TimeoutError" ? "timeout" : e.message}`, true);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new ModelError(`Bedrock answered HTTP ${res.status}: ${detail}`, isTransientStatus(res.status));
  }
  return parseResponse(await res.json(), request.toolName, Date.now() - started);
}

/** Retries only temporary failures, a few times, and logs every wait. Returns the reply and how many retries were used. */
export async function callWithRetries(
  settings: BedrockSettings,
  request: ModelRequest,
  options: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<{ reply: ModelReply; retries: number }> {
  const maxRetries = options.maxRetries ?? 2;
  const base = options.baseDelayMs ?? 500;
  for (let retries = 0; ; retries++) {
    try {
      return { reply: await once(settings, request), retries };
    } catch (error) {
      if (!(error instanceof ModelError) || !error.transient || retries >= maxRetries) {
        if (error instanceof ModelError) (error as ModelError & { retries?: number }).retries = retries;
        throw error;
      }
      const delay = base * 2 ** retries;
      console.warn(`[bedrock] ${error.message}; retry ${retries + 1}/${maxRetries} after ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
