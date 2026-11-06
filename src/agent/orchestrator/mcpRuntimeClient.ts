import { loadConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { McpHttpClient } from "../../mcpHttpClient.js";
import { OAuthTokenManager } from "../../oauthTokenManager.js";
import { configureHttpProxy } from "../../proxy.js";

let client: McpHttpClient | undefined;

export async function runMcpTool(
  tool: string,
  args: string[]
): Promise<{ stdout: string; durationMs: number }> {
  const started = Date.now();
  const mcpClient = getClient();
  const params = buildToolCallParams(tool, args);
  const result = await mcpClient.call<unknown>("tools/call", params);
  const stdout = normalizeToolResult(result);
  return {
    stdout,
    durationMs: Date.now() - started
  };
}

function getClient(): McpHttpClient {
  if (client) {
    return client;
  }

  const config = loadConfig();
  const promptLogLevel = process.env.PROMPT_VERBOSE === "1" ? config.logLevel : "error";
  const logger = createLogger(promptLogLevel);
  configureHttpProxy(logger);

  if (config.authMode === "basic") {
    client = new McpHttpClient({
      mcpUrl: config.mcpUrl,
      basicAuth: {
        username: config.basicUsername!,
        password: config.basicPassword!
      },
      logger
    });
    return client;
  }

  const tokenManager = new OAuthTokenManager({
    tokenUrl: config.oauthTokenUrl!,
    clientId: config.clientId!,
    clientSecret: config.clientSecret!,
    scope: config.oauthScope,
    logger
  });

  client = new McpHttpClient({
    mcpUrl: config.mcpUrl,
    tokenManager,
    logger
  });
  return client;
}

function buildToolCallParams(tool: string, args: string[]): Record<string, unknown> {
  const argumentsPayload: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--timeout") {
      i += 1;
      continue;
    }

    const separator = arg.indexOf("=");
    if (separator < 1) {
      continue;
    }

    const key = arg.slice(0, separator);
    const rawValue = arg.slice(separator + 1);
    argumentsPayload[key] = coerceValue(rawValue);
  }

  return {
    name: tool,
    arguments: argumentsPayload
  };
}

function coerceValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return numeric;
  }

  return trimmed;
}

function normalizeToolResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return JSON.stringify(result ?? {});
  }

  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : undefined;
  if (!content || content.length === 0) {
    return JSON.stringify({ result: record });
  }

  const textChunks = content
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const obj = item as Record<string, unknown>;
      return typeof obj.text === "string" ? obj.text : "";
    })
    .filter((t) => t.length > 0);

  if (textChunks.length === 0) {
    return JSON.stringify({ result: record });
  }

  return textChunks.join("\n");
}
