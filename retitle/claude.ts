// One-shot text completion through the local Claude Code CLI, stripped down to
// a bare model call: no tools, MCP servers, settings, skills, or thinking. It
// reuses the machine's existing Claude login, so the plugin needs no API key.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { TitlePrompt } from "./prompt";

export interface Completion {
  text: string;
  costUsd: number | null;
  durationMs: number;
}

export type Complete = (prompt: TitlePrompt, signal?: AbortSignal) => Promise<Completion>;

const TIMEOUT_MS = 60_000;

export async function completeWithClaude(
  model: string,
  prompt: TitlePrompt,
  signal?: AbortSignal,
): Promise<Completion> {
  const env: NodeJS.ProcessEnv = { ...process.env, MAX_THINKING_TOKENS: "0" };
  // A nested Claude Code session would otherwise attach to its parent.
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  const args = [
    "-p",
    "--model", model,
    "--system-prompt", prompt.system,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", "json",
  ];
  const stdout = await run("claude", args, prompt.user, { env, signal });
  const result = JSON.parse(stdout) as {
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    duration_ms?: number;
  };
  if (result.is_error || typeof result.result !== "string") {
    throw new Error(`claude returned an error: ${String(result.result).slice(0, 300)}`);
  }
  return {
    text: result.result,
    costUsd: result.total_cost_usd ?? null,
    durationMs: result.duration_ms ?? 0,
  };
}

function run(
  command: string,
  args: string[],
  input: string,
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: tmpdir(),
      env: options.env,
      signal: options.signal,
      timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code ?? signal}: ${(stderr || stdout).slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}
