import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  type InitializeResult
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { OAuthTokenManager } from "./oauthTokenManager.js";
import { McpHttpClient } from "./mcpHttpClient.js";
import { configureHttpProxy } from "./proxy.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  configureHttpProxy(logger);

  logger.info(
    {
      instanceUrl: config.instanceUrl,
      mcpUrl: config.mcpUrl,
      oauthTokenUrl: config.oauthTokenUrl,
      authMode: config.authMode
    },
    "Starting ServiceNow MCP bridge"
  );

  const tokenManager =
    config.authMode === "oauth"
      ? new OAuthTokenManager({
          tokenUrl: config.oauthTokenUrl!,
          clientId: config.clientId!,
          clientSecret: config.clientSecret!,
          scope: config.oauthScope,
          logger
        })
      : undefined;

  const mcpClient =
    config.authMode === "basic"
      ? new McpHttpClient({
          mcpUrl: config.mcpUrl,
          basicAuth: {
            username: config.basicUsername!,
            password: config.basicPassword!
          },
          logger
        })
      : new McpHttpClient({
          mcpUrl: config.mcpUrl,
          tokenManager,
          logger
        });

  const server = new Server(
    {
      name: "servicenow-mcp-bridge",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    logger.info("Proxying initialize request");
    const result = await mcpClient.call<InitializeResult>("initialize", request.params as Record<string, unknown>);
    return result;
  });

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    logger.info("Proxying tools/list request");
    const result = await mcpClient.call("tools/list", request.params as Record<string, unknown> | undefined);
    return result as { tools: unknown[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params?.name;
    logger.info({ toolName }, "Proxying tools/call request");
    const result = await mcpClient.call("tools/call", request.params as Record<string, unknown>);
    return result as {
      content: Array<{ type: string; text?: string; [key: string]: unknown }>;
      isError?: boolean;
      [key: string]: unknown;
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("ServiceNow MCP bridge connected over stdio");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal startup error: ${message}\n`);
  process.exit(1);
});