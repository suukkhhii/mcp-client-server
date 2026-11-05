import { spawn } from "node:child_process";

const configPath = ".\\.mcp.json";

export async function runMcporterCall(
  selector: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const mcporterArgs = [
      "--yes",
      "mcporter",
      "--config",
      configPath,
      "call",
      selector,
      ...args
    ];

    const child = spawn("npx", mcporterArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - started;
      if (code === 0) {
        resolve({ stdout, stderr, durationMs });
        return;
      }

      const message = stderr || stdout || `mcporter exited with code ${code}`;
      reject(new Error(message));
    });
  });
}
