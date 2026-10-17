import { execFile, spawn } from "node:child_process";

export interface GitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
}

// Inherited repository overrides would point every command at the wrong repo.
const REPO_OVERRIDE_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
];

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    // Paths from git output are file names, never globs.
    GIT_LITERAL_PATHSPECS: "1",
    ...extra,
  };
  for (const name of REPO_OVERRIDE_VARS) delete env[name];
  return env;
}

/** Runs git in `cwd` and resolves its stdout, or rejects with git's own error text. */
export function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: gitEnv(options.env),
        signal: options.signal,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        // `git commit` reports "nothing to commit" on stdout. Output that
        // overflowed the buffer is never an error message.
        const detail =
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "output too large"
            : error.killed
              ? "timed out"
              : stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`git ${args.join(" ")} failed: ${detail.slice(0, 2000)}`));
      },
    );
  });
}

/** Like `git`, but a failing command resolves null. For probes whose failure is an answer. */
export function tryGit(
  cwd: string,
  args: readonly string[],
  options?: GitOptions,
): Promise<string | null> {
  return git(cwd, args, options).catch(() => null);
}

/**
 * Runs git and resolves its stdout cut at `maxBytes`, stopping git there.
 * `truncated` says whether it was cut. Exit code 1 with nothing on stderr
 * counts as success, because `git diff --no-index` uses it to say the
 * files differ.
 */
export function gitCapped(
  cwd: string,
  args: readonly string[],
  options: { maxBytes: number; timeoutMs: number },
): Promise<{ stdout: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnv(), timeout: options.timeoutMs });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxBytes - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.length, room);
      if (chunk.length > room) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(chunks).toString();
      if (truncated || code === 0 || (code === 1 && stderr.trim() === "")) {
        resolve({ stdout, truncated });
      } else {
        const detail = signal === null ? stderr.trim() || `exit ${code}` : "timed out";
        reject(new Error(`git ${args.join(" ")} failed: ${detail.slice(0, 2000)}`));
      }
    });
  });
}

/**
 * The remote a repo's work is based on: `upstream` when a fork has one,
 * else `origin`, else its first remote. Null when it has none.
 */
export async function baseRemote(dir: string): Promise<string | null> {
  const remotes = ((await tryGit(dir, ["remote"])) ?? "").split("\n").filter(Boolean);
  return ["upstream", "origin"].find((name) => remotes.includes(name)) ?? remotes[0] ?? null;
}

/** The top level of the work tree containing `dir`, or null outside one. */
export async function toplevel(dir: string): Promise<string | null> {
  const top = await tryGit(dir, ["rev-parse", "--show-toplevel"]);
  return top === null ? null : top.trim();
}

/**
 * `branch.<name>.<START_CONFIG>` holds the commit a workspace branch started
 * from when the user chose the start. The Changes panel compares against it.
 */
export const START_CONFIG = "workspacesStart";
