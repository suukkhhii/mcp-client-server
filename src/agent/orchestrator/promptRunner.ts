import { routePrompt, extractIncidentNumber } from "../router/intentRouter.js";
import type { PromptResponseEnvelope, ToolInvocation } from "../types/index.js";
import { runMcporterCall } from "./mcporterClient.js";

export async function runPrompt(prompt: string): Promise<PromptResponseEnvelope> {
  const decision = routePrompt(prompt);
  const invocation: ToolInvocation = {
    server: decision.server,
    tool: decision.tool,
    args: decision.args,
    success: false
  };

  try {
    const selector = `${decision.server}.${decision.tool}`;
    const { stdout, durationMs } = await runMcporterCall(selector, decision.args);

    invocation.success = true;
    invocation.durationMs = durationMs;

    const normalized = normalizeResult(decision.tool, prompt, stdout);

    return {
      prompt,
      intent: decision.tool,
      confidence: decision.confidence,
      reason: decision.reason,
      toolInvocations: [invocation],
      rawResult: stdout,
      normalized,
      insights: buildInsights(decision.tool, normalized),
      warnings: []
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    invocation.success = false;
    invocation.error = message;

    return {
      prompt,
      intent: decision.tool,
      confidence: decision.confidence,
      reason: decision.reason,
      toolInvocations: [invocation],
      insights: [],
      warnings: [
        "Tool execution failed. Verify proxy/env settings and MCP server availability."
      ]
    };
  }
}

function normalizeResult(tool: string, prompt: string, raw: string): PromptResponseEnvelope["normalized"] {
  if (tool === "incident_summarization") {
    const incidentNumber = extractIncidentNumber(prompt) ?? undefined;
    return {
      incidentNumber,
      summaryHtml: raw.trim()
    };
  }

  const parsed = tryParseLooseObject(raw);
  const result = parsed && typeof parsed === "object" && "result" in parsed
    ? (parsed as Record<string, unknown>).result
    : undefined;

  const records =
    result && typeof result === "object" && result !== null && Array.isArray((result as Record<string, unknown>).records)
      ? ((result as Record<string, unknown>).records as Array<Record<string, unknown>>)
      : undefined;

  const countRaw =
    result && typeof result === "object" && result !== null
      ? (result as Record<string, unknown>).count
      : undefined;

  const count = typeof countRaw === "number" ? countRaw : undefined;

  return {
    records,
    count
  };
}

function buildInsights(tool: string, normalized: PromptResponseEnvelope["normalized"]): string[] {
  if (tool === "incident_summarization") {
    return [
      "Incident summary retrieved successfully.",
      "Review the summary for root cause, impact, and operational next steps."
    ];
  }

  const count = normalized?.count;
  if (typeof count === "number") {
    return [
      `Lookup returned ${count} incident record(s).`,
      "You can request summarization for any returned incident number."
    ];
  }

  return ["Lookup completed."];
}

function tryParseLooseObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // mcporter may print JS-style single-quote objects; normalize best-effort.
    const normalized = trimmed
      .replace(/\bNone\b/g, "null")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/'/g, '"');

    try {
      return JSON.parse(normalized);
    } catch {
      return undefined;
    }
  }
}
