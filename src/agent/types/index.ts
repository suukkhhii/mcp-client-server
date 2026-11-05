export type RouteIntent = "incident_summarization" | "look_up_incident_records";

export type RouteDecision = {
  server: string;
  tool: RouteIntent;
  args: string[];
  confidence: number;
  reason: string;
};

export type ToolInvocation = {
  server: string;
  tool: string;
  args: string[];
  durationMs?: number;
  success: boolean;
  error?: string;
};

export type PromptResponseEnvelope = {
  prompt: string;
  intent: RouteIntent;
  confidence: number;
  reason: string;
  toolInvocations: ToolInvocation[];
  rawResult?: string;
  normalized?: {
    incidentNumber?: string;
    summaryHtml?: string;
    records?: Array<Record<string, unknown>>;
    count?: number;
  };
  insights: string[];
  warnings: string[];
};
