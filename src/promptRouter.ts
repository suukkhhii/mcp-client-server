import { runPrompt } from "./agent/orchestrator/promptRunner.js";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  const verbose = process.env.PROMPT_VERBOSE === "1";

  if (!prompt) {
    console.error("Usage: npm run prompt -- \"please help me with incident details INC12345\"");
    process.exit(1);
  }

  const response = await runPrompt(prompt);

  if (verbose) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const result = formatResultOnly(response);
  if (!result) {
    const warning = response.warnings[0] ?? "No result returned.";
    console.error(warning);
    process.exit(1);
  }

  console.log(result);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[router] Failed: ${message}`);
  process.exit(1);
});

function formatResultOnly(response: Awaited<ReturnType<typeof runPrompt>>): string | null {
  const normalized = response.normalized;

  if (normalized?.summaryHtml) {
    return htmlToPlainText(normalized.summaryHtml);
  }

  if (normalized?.records && normalized.records.length > 0) {
    return JSON.stringify(normalized.records, null, 2);
  }

  if (typeof normalized?.count === "number") {
    return `Count: ${normalized.count}`;
  }

  const raw = response.rawResult?.trim();
  if (raw) {
    return raw;
  }

  return null;
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
