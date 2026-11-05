import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  SN_INSTANCE_URL: z.string().url(),
  SN_MCP_URL: z.string().url(),
  SN_OAUTH_TOKEN_URL: z.string().url().optional(),
  SN_CLIENT_ID: z.string().min(1).optional(),
  SN_CLIENT_SECRET: z.string().min(1).optional(),
  SN_OAUTH_SCOPE: z.string().optional(),
  SN_AUTH_MODE: z.enum(["oauth", "basic"]).optional().default("oauth"),
  SN_BASIC_USERNAME: z.string().optional(),
  SN_BASIC_PASSWORD: z.string().optional(),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .optional()
    .default("info")
});

export type AppConfig = {
  instanceUrl: string;
  mcpUrl: string;
  authMode: "oauth" | "basic";
  oauthTokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  oauthScope?: string;
  basicUsername?: string;
  basicPassword?: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const env = parsed.data;

  if (env.SN_AUTH_MODE === "oauth") {
    if (!env.SN_OAUTH_TOKEN_URL || !env.SN_CLIENT_ID || !env.SN_CLIENT_SECRET) {
      throw new Error(
        "Invalid environment configuration: SN_OAUTH_TOKEN_URL, SN_CLIENT_ID, and SN_CLIENT_SECRET are required when SN_AUTH_MODE=oauth"
      );
    }
  }

  if (env.SN_AUTH_MODE === "basic") {
    if (!env.SN_BASIC_USERNAME || !env.SN_BASIC_PASSWORD) {
      throw new Error(
        "Invalid environment configuration: SN_BASIC_USERNAME and SN_BASIC_PASSWORD are required when SN_AUTH_MODE=basic"
      );
    }
  }

  return {
    instanceUrl: env.SN_INSTANCE_URL,
    mcpUrl: env.SN_MCP_URL,
    authMode: env.SN_AUTH_MODE,
    oauthTokenUrl: env.SN_OAUTH_TOKEN_URL,
    clientId: env.SN_CLIENT_ID,
    clientSecret: env.SN_CLIENT_SECRET,
    oauthScope: env.SN_OAUTH_SCOPE,
    basicUsername: env.SN_BASIC_USERNAME,
    basicPassword: env.SN_BASIC_PASSWORD,
    logLevel: env.LOG_LEVEL
  };
}