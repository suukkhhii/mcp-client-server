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

type BuiltPayload = {
  payload: JsonRecord;
  requestId?: number;
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
    const built = this.buildPayload(shape, method, params);
    const payload = built.payload;

    const firstResponse = await this.sendRequest(authHeaders, payload);
    if (firstResponse.status === 401 && this.tokenManager) {
      this.logger.warn({ method }, "401 from MCP endpoint, refreshing token and retrying once");
      this.tokenManager.invalidateToken();
      const refreshedToken = await this.tokenManager.getAccessToken();
      const retryResponse = await this.sendRequest(
        { Authorization: `Bearer ${refreshedToken}` },
        payload
      );
      return this.handleResponse<T>(
        shape,
        method,
        retryResponse.status,
        retryResponse.bodyText,
        built.requestId
      );
    }

    return this.handleResponse<T>(
      shape,
      method,
      firstResponse.status,
      firstResponse.bodyText,
      built.requestId
    );
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

  private buildPayload(shape: PayloadShape, method: string, params?: JsonRecord): BuiltPayload {
    const requestId = this.requestIdCounter++;
    const baseRequest = {
      method,
      ...(params ? { params } : {})
    };

    if (shape === "request-wrapper") {
      return {
        payload: {
          request: {
            jsonrpc: "2.0",
            id: requestId,
            ...baseRequest
          }
        },
        requestId
      };
    }

    if (shape === "plain") {
      return {
        payload: baseRequest
      };
    }

    return {
      payload: {
        jsonrpc: "2.0",
        id: requestId,
        ...baseRequest
      },
      requestId
    };
  }

  private handleResponse<T>(
    shape: PayloadShape,
    method: string,
    status: number,
    bodyText: string,
    expectedRequestId?: number
  ): T {
    const parsed = parseJsonSafely(bodyText);
    const parsedCandidate = selectBestMcpMessage(parsed, expectedRequestId);

    if (status >= 400) {
      throw new HttpStatusError(
        status,
        extractErrorMessage(parsedCandidate ?? parsed) ?? `HTTP ${status}`,
        parsedCandidate ?? parsed
      );
    }

    if (shape === "plain") {
      const plainCandidate = parsedCandidate ?? parsed;

      if (isJsonRecord(plainCandidate) && Object.prototype.hasOwnProperty.call(plainCandidate, "error")) {
        throw new RemoteMcpError(
          extractErrorMessage((plainCandidate as JsonRecord).error) ?? "Remote MCP error",
          plainCandidate
        );
      }

      if (isJsonRecord(plainCandidate) && Object.prototype.hasOwnProperty.call(plainCandidate, "result")) {
        return (plainCandidate as JsonRecord).result as T;
      }

      return plainCandidate as T;
    }

    const candidate = parsedCandidate ?? parsed;
    const unwrapped = unwrapResponseEnvelope(candidate);
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
  if (sseParsed.length > 0) {
    return sseParsed.length === 1 ? sseParsed[0] : sseParsed;
  }

  try {
    return JSON.parse(text);
  } catch {
    const manyJson = tryParseManyJsonObjects(text);
    if (manyJson.length > 0) {
      return manyJson.length === 1 ? manyJson[0] : manyJson;
    }

    return { raw: text };
  }
}

function tryParseSseDataJson(text: string): unknown[] {
  if (!/^(event:|data:)/m.test(text)) {
    return [];
  }

  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");

  const parsedMessages: unknown[] = [];
  for (const line of dataLines) {
    try {
      parsedMessages.push(JSON.parse(line));
    } catch {
      continue;
    }
  }

  return parsedMessages;
}

function tryParseManyJsonObjects(text: string): unknown[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return parsed;
}

function selectBestMcpMessage(value: unknown, expectedRequestId?: number): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  if (value.length === 0) {
    return {};
  }

  if (expectedRequestId !== undefined) {
    const exactMatch = value.find((entry) => {
      if (!isJsonRecord(entry)) {
        return false;
      }
      return entry.id === expectedRequestId && ("result" in entry || "error" in entry);
    });
    if (exactMatch) {
      return exactMatch;
    }
  }

  const resultLike = value.find(
    (entry) => isJsonRecord(entry) && ("result" in entry || "error" in entry)
  );
  if (resultLike) {
    return resultLike;
  }

  return value[value.length - 1];
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