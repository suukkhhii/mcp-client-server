import type { Logger } from "pino";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OAuthTokenManager } from "./oauthTokenManager.js";

type JsonRecord = Record<string, unknown>;

type PayloadShape = "jsonrpc" | "request-wrapper" | "plain";

type McpHttpClientOptions = {
  mcpUrl: string;
  tokenManager?: OAuthTokenManager;
  basicAuth?: {
    username: string;
    password: string;
  };
  logger: Logger;
};

export class McpHttpClient {
  private readonly mcpUrl: string;
  private readonly tokenManager?: OAuthTokenManager;
  private readonly basicAuth?: {
    username: string;
    password: string;
  };
  private readonly logger: Logger;
  private shapePreference: PayloadShape = "jsonrpc";
  private requestIdCounter = 1;

  constructor(options: McpHttpClientOptions) {
    this.mcpUrl = options.mcpUrl;
    this.tokenManager = options.tokenManager;
    this.basicAuth = options.basicAuth;
    this.logger = options.logger;

    if (!this.tokenManager && !this.basicAuth) {
      throw new Error("McpHttpClient requires either tokenManager or basicAuth");
    }
  }

  async call<T = unknown>(method: string, params?: JsonRecord): Promise<T> {
    const orderedShapes = this.getShapeOrder();
    let lastError: unknown;

    for (const shape of orderedShapes) {
      try {
        const result = await this.callWithShape<T>(shape, method, params);
        this.shapePreference = shape;
        return result;
      } catch (error) {
        lastError = error;

        if (!isShapeMismatchError(error)) {
          throw mapToMcpError(error, method);
        }

        this.logger.warn(
          { method, attemptedShape: shape, reason: getErrorMessage(error) },
          "MCP shape mismatch detected, trying fallback shape"
        );
      }
    }

    throw mapToMcpError(lastError, method);
  }

  private getShapeOrder(): PayloadShape[] {
    const all: PayloadShape[] = ["jsonrpc", "request-wrapper", "plain"];
    return [this.shapePreference, ...all.filter((shape) => shape !== this.shapePreference)];
  }

  private async callWithShape<T>(
    shape: PayloadShape,
    method: string,
    params?: JsonRecord
  ): Promise<T> {
    const authHeaders = await this.getAuthHeaders();
    const payload = this.buildPayload(shape, method, params);

    const firstResponse = await this.sendRequest(authHeaders, payload);
    if (firstResponse.status === 401 && this.tokenManager) {
      this.logger.warn({ method }, "401 from MCP endpoint, refreshing token and retrying once");
      this.tokenManager.invalidateToken();
      const refreshedToken = await this.tokenManager.getAccessToken();
      const retryResponse = await this.sendRequest(
        { Authorization: `Bearer ${refreshedToken}` },
        payload
      );
      return this.handleResponse<T>(shape, method, retryResponse.status, retryResponse.bodyText);
    }

    return this.handleResponse<T>(shape, method, firstResponse.status, firstResponse.bodyText);
  }

  private async sendRequest(
    authHeaders: Record<string, string>,
    payload: JsonRecord
  ): Promise<{ status: number; bodyText: string }> {
    let response: Response;

    try {
      response = await fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      throw new Error(`Network error while calling MCP endpoint: ${getErrorMessage(error)}`);
    }

    const bodyText = await response.text();
    return { status: response.status, bodyText };
  }

  private buildPayload(shape: PayloadShape, method: string, params?: JsonRecord): JsonRecord {
    const baseRequest = {
      method,
      ...(params ? { params } : {})
    };

    if (shape === "request-wrapper") {
      return {
        request: {
          jsonrpc: "2.0",
          id: this.requestIdCounter++,
          ...baseRequest
        }
      };
    }

    if (shape === "plain") {
      return baseRequest;
    }

    return {
      jsonrpc: "2.0",
      id: this.requestIdCounter++,
      ...baseRequest
    };
  }

  private handleResponse<T>(shape: PayloadShape, method: string, status: number, bodyText: string): T {
    const parsed = parseJsonSafely(bodyText);

    if (status >= 400) {
      throw new HttpStatusError(status, extractErrorMessage(parsed) ?? `HTTP ${status}`, parsed);
    }

    if (shape === "plain") {
      if (isJsonRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "error")) {
        throw new RemoteMcpError(extractErrorMessage((parsed as JsonRecord).error) ?? "Remote MCP error", parsed);
      }

      if (isJsonRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "result")) {
        return (parsed as JsonRecord).result as T;
      }

      return parsed as T;
    }

    const unwrapped = unwrapResponseEnvelope(parsed);
    if (unwrapped !== parsed) {
      if (isJsonRecord(unwrapped) && Object.prototype.hasOwnProperty.call(unwrapped, "error")) {
        throw new RemoteMcpError(
          extractErrorMessage((unwrapped as JsonRecord).error) ?? "Remote MCP error",
          unwrapped
        );
      }

      if (isJsonRecord(unwrapped) && Object.prototype.hasOwnProperty.call(unwrapped, "result")) {
        return (unwrapped as JsonRecord).result as T;
      }
    }

    if (isJsonRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "error")) {
      throw new RemoteMcpError(extractErrorMessage((parsed as JsonRecord).error) ?? "Remote MCP error", parsed);
    }

    if (isJsonRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "result")) {
      return (parsed as JsonRecord).result as T;
    }

    throw new Error(
      `Unexpected MCP response for method ${method}: ${truncateForLog(JSON.stringify(parsed))}`
    );
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.basicAuth) {
      const basic = Buffer.from(
        `${this.basicAuth.username}:${this.basicAuth.password}`,
        "utf-8"
      ).toString("base64");
      return {
        Authorization: `Basic ${basic}`
      };
    }

    const token = await this.tokenManager!.getAccessToken();
    return {
      Authorization: `Bearer ${token}`
    };
  }
}

class HttpStatusError extends Error {
  status: number;
  details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class RemoteMcpError extends Error {
  details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

function parseJsonSafely(text: string): unknown {
  if (!text) {
    return {};
  }

  const sseParsed = tryParseSseDataJson(text);
  if (sseParsed !== undefined) {
    return sseParsed;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function tryParseSseDataJson(text: string): unknown | undefined {
  if (!/^(event:|data:)/m.test(text)) {
    return undefined;
  }

  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");

  for (const line of dataLines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }

  return undefined;
}

function unwrapResponseEnvelope(value: unknown): unknown {
  if (!isJsonRecord(value)) {
    return value;
  }

  const response = (value as JsonRecord).response;
  if (isJsonRecord(response)) {
    return response;
  }

  return value;
}

function truncateForLog(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isJsonRecord(value)) {
    return undefined;
  }

  const message = value.message;
  if (typeof message === "string") {
    return message;
  }

  const error = value.error;
  if (typeof error === "string") {
    return error;
  }
  if (isJsonRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function isShapeMismatchError(error: unknown): boolean {
  if (!(error instanceof HttpStatusError)) {
    return false;
  }

  if (error.status !== 400 && error.status !== 404 && error.status !== 415 && error.status !== 422) {
    return false;
  }

  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("invalid") ||
    message.includes("unsupported") ||
    message.includes("payload") ||
    message.includes("json") ||
    message.includes("request") ||
    message.includes("method")
  );
}

function mapToMcpError(error: unknown, method: string): McpError {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof HttpStatusError) {
    if (error.status === 401 || error.status === 403) {
      return new McpError(
        ErrorCode.InvalidRequest,
        `Authorization failed while calling ${method}: ${error.message}`
      );
    }

    if (error.status === 404) {
      return new McpError(ErrorCode.MethodNotFound, `Remote MCP method not found: ${method}`);
    }

    return new McpError(
      ErrorCode.InternalError,
      `Remote MCP HTTP error (${error.status}) for ${method}: ${error.message}`
    );
  }

  if (error instanceof RemoteMcpError) {
    return new McpError(ErrorCode.InternalError, `Remote MCP error for ${method}: ${error.message}`);
  }

  const message = getErrorMessage(error);
  if (/network|fetch|timeout|econn|enotfound|socket/i.test(message)) {
    return new McpError(ErrorCode.InternalError, `Network error for ${method}: ${message}`);
  }

  return new McpError(ErrorCode.InternalError, `Unexpected error for ${method}: ${message}`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}