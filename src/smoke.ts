import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { OAuthTokenManager } from "./oauthTokenManager.js";
import { McpHttpClient } from "./mcpHttpClient.js";
import { configureHttpProxy } from "./proxy.js";

type ToolSummary = {
  name?: string;
  title?: string;
};

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  configureHttpProxy(logger);

  let mcpClient: McpHttpClient;
  if (config.authMode === "basic") {
    mcpClient = new McpHttpClient({
      mcpUrl: config.mcpUrl,
      basicAuth: {
        username: config.basicUsername!,
        password: config.basicPassword!
      },
      logger
    });
    console.log("Auth mode: basic");
  } else {
    const tokenManager = new OAuthTokenManager({
      tokenUrl: config.oauthTokenUrl!,
      clientId: config.clientId!,
      clientSecret: config.clientSecret!,
      scope: config.oauthScope,
      logger
    });

    mcpClient = new McpHttpClient({
      mcpUrl: config.mcpUrl,
      tokenManager,
      logger
    });

    const token = await tokenManager.getAccessToken();
    console.log(`Token acquired: ${token ? "yes" : "no"}`);
  }

  const initializeResult = await mcpClient.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {
      roots: {
        listChanged: false
      }
    },
    clientInfo: {
      name: "servicenow-mcp-bridge-smoke",
      version: "1.0.0"
    }
  });

  console.log("Initialize succeeded.");
  console.log(JSON.stringify(initializeResult, null, 2));

  const toolsListResult = (await mcpClient.call("tools/list")) as {
    tools?: ToolSummary[];
  };

  const tools = toolsListResult.tools ?? [];
  console.log(`Tools found: ${tools.length}`);
  for (const tool of tools) {
    console.log(`- ${tool.name ?? tool.title ?? "(unnamed-tool)"}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke test failed: ${message}`);
  process.exit(1);
});