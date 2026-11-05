import "dotenv/config";
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
    return formatRecordsAsTable(normalized.records);
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

function formatRecordsAsTable(records: Array<Record<string, unknown>>): string {
  const keys = Array.from(
    new Set(records.flatMap((record) => Object.keys(record)))
  );

  if (keys.length === 0) {
    return "No records found.";
  }

  const widths = keys.map((key) => {
    const maxValueWidth = Math.max(
      ...records.map((record) => String(record[key] ?? "").length)
    );
    return Math.max(key.length, maxValueWidth);
  });

  const makeRow = (values: string[]) =>
    `| ${values
      .map((value, index) => value.padEnd(widths[index], " "))
      .join(" | ")} |`;

  const header = makeRow(keys);
  const divider = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const rows = records.map((record) =>
    makeRow(keys.map((key) => String(record[key] ?? "")))
  );

  return [header, divider, ...rows].join("\n");
}
