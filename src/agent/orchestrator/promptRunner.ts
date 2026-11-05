import { routePrompt, extractIncidentNumber } from "../router/intentRouter.js";
import type { PromptResponseEnvelope, ToolInvocation } from "../types/index.js";
import { runMcporterCall } from "./mcporterClient.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type CacheEntry = {
  value: string;
  expiresAt: number;
};

const responseCache = new Map<string, CacheEntry>();
let diskCacheLoaded = false;

const CACHE_TTL_LOOKUP_MS = getPositiveIntEnv("PROMPT_CACHE_LOOKUP_TTL_MS", 60_000);
const CACHE_TTL_SUMMARY_MS = getPositiveIntEnv("PROMPT_CACHE_SUMMARY_TTL_MS", 600_000);
const SOFT_TIMEOUT_MS = getPositiveIntEnv("PROMPT_SUMMARY_SOFT_TIMEOUT_MS", 30_000);
const CACHE_FILE_PATH = resolve(process.cwd(), ".cache", "prompt-cache.json");

export async function runPrompt(prompt: string): Promise<PromptResponseEnvelope> {
  await ensureCacheLoaded();

  const totalStart = Date.now();
  const routeStart = Date.now();
  const decision = routePrompt(prompt);
  const routeMs = Date.now() - routeStart;

  const selector = `${decision.server}.${decision.tool}`;
  const cacheKey = buildCacheKey(selector, decision.args);
  const cached = getCache(cacheKey);

  const invocation: ToolInvocation = {
    server: decision.server,
    tool: decision.tool,
    args: decision.args,
    cached: Boolean(cached),
    success: false
  };

  let fallbackUsed = false;

  try {
    const { stdout, durationMs } = cached
      ? { stdout: cached, durationMs: 0 }
      : await runMcporterCall(selector, decision.args);

    invocation.success = true;
    invocation.durationMs = durationMs;

    if (!cached) {
      await setCache(cacheKey, stdout, getTtlForTool(decision.tool));
    }

    const normalized = normalizeResult(decision.tool, prompt, stdout);
    const toolCallMs = Date.now() - totalStart - routeMs;

    const warnings: string[] = [];
    if (decision.tool === "incident_summarization" && toolCallMs > SOFT_TIMEOUT_MS) {
      warnings.push(
        `Summarization exceeded soft latency target (${SOFT_TIMEOUT_MS} ms); upstream ServiceNow processing may be slow.`
      );
    }

    return {
      prompt,
      intent: decision.tool,
      confidence: decision.confidence,
      reason: decision.reason,
      toolInvocations: [invocation],
      rawResult: stdout,
      metrics: {
        totalMs: Date.now() - totalStart,
        routeMs,
        toolCallMs,
        cacheHit: Boolean(cached),
        fallbackUsed
      },
      normalized,
      insights: buildInsights(decision.tool, normalized),
      warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    invocation.success = false;
    invocation.error = message;

    // Fallback: if summarization fails or times out, return quick lookup details when possible.
    if (decision.tool === "incident_summarization") {
      const incidentNumber = extractIncidentNumber(prompt);
      if (incidentNumber) {
        const fallbackArgs = [`limit=1`, `number=${incidentNumber}`];
        const fallbackSelector = `${decision.server}.look_up_incident_records`;
        const fallbackCacheKey = buildCacheKey(fallbackSelector, fallbackArgs);

        try {
          const fallbackCached = getCache(fallbackCacheKey);
          const fallbackResult = fallbackCached
            ? { stdout: fallbackCached, durationMs: 0 }
            : await runMcporterCall(fallbackSelector, fallbackArgs);

          if (!fallbackCached) {
            await setCache(fallbackCacheKey, fallbackResult.stdout, CACHE_TTL_LOOKUP_MS);
          }

          fallbackUsed = true;
          const fallbackInvocation: ToolInvocation = {
            server: decision.server,
            tool: "look_up_incident_records",
            args: fallbackArgs,
            durationMs: fallbackResult.durationMs,
            cached: Boolean(fallbackCached),
            success: true
          };

          return {
            prompt,
            intent: decision.tool,
            confidence: decision.confidence,
            reason: decision.reason,
            toolInvocations: [invocation, fallbackInvocation],
            rawResult: fallbackResult.stdout,
            metrics: {
              totalMs: Date.now() - totalStart,
              routeMs,
              toolCallMs: Date.now() - totalStart - routeMs,
              cacheHit: Boolean(cached),
              fallbackUsed
            },
            normalized: normalizeResult("look_up_incident_records", prompt, fallbackResult.stdout),
            insights: [
              "Summarization failed or timed out; returned incident details from lookup fallback.",
              "Retry summarization later or increase timeout for large NowAssist workloads."
            ],
            warnings: [
              `Summarization failed: ${message}`,
              "Fallback result is lookup data, not AI summary output."
            ]
          };
        } catch {
          // keep original error response when fallback also fails
        }
      }
    }

    return {
      prompt,
      intent: decision.tool,
      confidence: decision.confidence,
      reason: decision.reason,
      toolInvocations: [invocation],
      metrics: {
        totalMs: Date.now() - totalStart,
        routeMs,
        toolCallMs: Date.now() - totalStart - routeMs,
        cacheHit: Boolean(cached),
        fallbackUsed
      },
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

function buildCacheKey(selector: string, args: string[]): string {
  return `${selector}::${args.join("|")}`;
}

function getCache(key: string): string | undefined {
  const entry = responseCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return undefined;
  }
  return entry.value;
}

async function setCache(key: string, value: string, ttlMs: number): Promise<void> {
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });

  await persistCache();
}

function getTtlForTool(tool: string): number {
  return tool === "incident_summarization" ? CACHE_TTL_SUMMARY_MS : CACHE_TTL_LOOKUP_MS;
}

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

async function ensureCacheLoaded(): Promise<void> {
  if (diskCacheLoaded) {
    return;
  }

  diskCacheLoaded = true;

  try {
    const content = await readFile(CACHE_FILE_PATH, "utf8");
    const parsed = JSON.parse(content) as Record<string, CacheEntry>;
    const now = Date.now();

    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.value === "string" && typeof entry.expiresAt === "number" && entry.expiresAt > now) {
        responseCache.set(key, entry);
      }
    }
  } catch {
    // cache file is optional; continue with empty cache
  }
}

async function persistCache(): Promise<void> {
  const now = Date.now();
  for (const [key, entry] of responseCache.entries()) {
    if (entry.expiresAt <= now) {
      responseCache.delete(key);
    }
  }

  try {
    await mkdir(dirname(CACHE_FILE_PATH), { recursive: true });
    const payload = JSON.stringify(Object.fromEntries(responseCache.entries()));
    await writeFile(CACHE_FILE_PATH, payload, "utf8");
  } catch {
    // cache persistence failure should not break prompt handling
  }
}
