import routerConfig from "../config/routerConfig.json" with { type: "json" };
import type { RouteDecision } from "../types/index.js";

type RouterConfig = {
  defaultServer: string;
  defaultTimeoutMs: number;
  lookup: {
    defaultLimit: number;
    maxLimit: number;
    statusKeywords: Record<string, string>;
    priorityKeywords: Record<string, string>;
  };
};

const config = routerConfig as RouterConfig;

export function routePrompt(prompt: string): RouteDecision {
  const incidentNumber = extractIncidentNumber(prompt);

  if (incidentNumber) {
    return {
      server: config.defaultServer,
      tool: "incident_summarization",
      args: [`incidentNumber=${incidentNumber}`, "--timeout", String(getCallTimeout())],
      confidence: 0.99,
      reason: `Detected incident number ${incidentNumber}`
    };
  }

  const args = buildLookupArgs(prompt);
  return {
    server: config.defaultServer,
    tool: "look_up_incident_records",
    args,
    confidence: 0.78,
    reason: "No explicit incident number found; using lookup strategy"
  };
}

export function extractIncidentNumber(text: string): string | null {
  const match = text.match(/\bINC\d{4,}\b/i);
  return match ? match[0].toUpperCase() : null;
}

function buildLookupArgs(text: string): string[] {
  const args: string[] = [];
  const lowered = text.toLowerCase();

  const limit = extractLimit(lowered);
  args.push(`limit=${limit}`);

  const status = matchKeyword(lowered, config.lookup.statusKeywords);
  if (status) {
    args.push(`status=${status}`);
  }

  const priority = matchKeyword(lowered, config.lookup.priorityKeywords);
  if (priority) {
    args.push(`priority=${priority}`);
  }

  args.push("--timeout", String(getCallTimeout()));
  return args;
}

function extractLimit(lowered: string): number {
  const match = lowered.match(/\b(?:top|last|limit)\s+(\d{1,3})\b/) ?? lowered.match(/\b(\d{1,3})\s+(?:incidents?|records?)\b/);
  const parsed = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(parsed)) {
    return config.lookup.defaultLimit;
  }
  return Math.max(1, Math.min(config.lookup.maxLimit, parsed));
}

function matchKeyword(text: string, keywordMap: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(keywordMap)) {
    if (text.includes(key)) {
      return value;
    }
  }
  return undefined;
}

function getCallTimeout(): number {
  const envValue = process.env.MCPORTER_CALL_TIMEOUT;
  const parsed = envValue ? Number(envValue) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return config.defaultTimeoutMs;
}
