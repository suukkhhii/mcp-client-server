import { runPrompt } from "./agent/orchestrator/promptRunner.js";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error("Usage: npm run prompt -- \"please help me with incident details INC12345\"");
    process.exit(1);
  }

  const response = await runPrompt(prompt);
  console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[router] Failed: ${message}`);
  process.exit(1);
});
