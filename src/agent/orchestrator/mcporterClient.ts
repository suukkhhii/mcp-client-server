import { spawn } from "node:child_process";

const configPath = ".\\.mcp.json";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

export async function runMcporterCall(
  selector: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const started = Date.now();
  const mcporterArgs = [
    "--yes",
    "mcporter",
    "--config",
    configPath,
    "call",
    selector,
    ...args
  ];

  try {
    return await runProcess(npxCommand, mcporterArgs, false, started);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isRecoverableLaunchError(message)) {
      throw error;
    }

    // Fallback for Windows shells where direct cmd spawning is unavailable.
    const shellCommand = buildShellCommand(npxCommand, mcporterArgs);
    return runProcess(shellCommand, [], true, started);
  }
}

function runProcess(
  command: string,
  commandArgs: string[],
  useShell: boolean,
  started: number
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: useShell
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start mcporter call: ${error.message}`));
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

function isRecoverableLaunchError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("enoent") || lowered.includes("einval");
}

function buildShellCommand(command: string, commandArgs: string[]): string {
  return [command, ...commandArgs].map(quoteForShell).join(" ");
}

function quoteForShell(value: string): string {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}
