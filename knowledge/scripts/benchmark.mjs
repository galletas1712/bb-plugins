#!/usr/bin/env node
// Run from the benchmark's BB workspace. All command arguments stay literal.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(`Usage: node benchmark.mjs --context context.json --output NEW_RUN_DIR [--thread ID] -- COMMAND [ARGS...]

context.json supplies title, hardware, environment, workload, configuration,
and optional revision, dirty, and body. The workload may write
results.json in KNOWLEDGE_RUN_DIR as [{name, unit, values}]. Elapsed seconds are always
measured. stdout.log and stderr.log are preserved. On completion the wrapper writes
manifest.json, results.json, report.md, capture.json, and a capture receipt.

Requires a BB thread and the Knowledge plugin. Failed capture leaves all run files
for retry with: bb knowledge save --input-stdin < RUN_DIR/capture.json
A nonzero workload exit is preserved even if evidence capture succeeds.`);
  process.exit(0);
}
const separator = argv.indexOf("--");
if (separator < 0) throw new Error("Separate the command with --. See --help.");
const { values } = parseArgs({
  args: argv.slice(0, separator),
  options: {
    context: { type: "string" },
    output: { type: "string" },
    thread: { type: "string" },
  },
});
const [command, ...args] = argv.slice(separator + 1);
if (!values.context || !values.output || !command)
  throw new Error("--context, --output, and a command are required");
const threadId = values.thread ?? process.env.BB_THREAD_ID;
if (!threadId) throw new Error("Run inside a BB thread or pass --thread");
const context = JSON.parse(fs.readFileSync(values.context, "utf8"));
for (const field of ["title", "hardware", "environment", "workload"])
  if (typeof context[field] !== "string" || !context[field].trim())
    throw new Error(`context.json needs ${field}`);
if (!context.configuration || typeof context.configuration !== "object")
  throw new Error("context.json needs configuration");
const output = path.resolve(values.output);
const relative = path.relative(process.cwd(), output);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
  throw new Error("Choose a new output directory inside the current workspace");
const write = (name, value) =>
  fs.writeFileSync(
    path.join(output, name),
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
  );
const git = (...args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};
const revision = context.revision ?? git("rev-parse", "HEAD");
const status = git("status", "--porcelain");
const dirty = context.dirty ?? (status === null ? null : status.length > 0);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output); // Refuse to overwrite an existing run.
const startedAt = new Date().toISOString();
const commandText = [command, ...args]
  .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
  .join(" ");
write("manifest.json", {
  revision,
  dirty,
  command: commandText,
  hardware: context.hardware,
  environment: context.environment,
  workload: context.workload,
  configuration: context.configuration,
  startedAt,
  completedAt: null,
  outcome: "incomplete",
});
const start = process.hrtime.bigint();
const stdout = fs.openSync(path.join(output, "stdout.log"), "wx");
const stderr = fs.openSync(path.join(output, "stderr.log"), "wx");
let failure = "";
let exitCode;
try {
  exitCode = await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, KNOWLEDGE_RUN_DIR: output },
      stdio: ["ignore", stdout, stderr],
    });
    child.once("error", (error) => {
      failure = error.message;
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
} finally {
  fs.closeSync(stdout);
  fs.closeSync(stderr);
}
const completedAt = new Date().toISOString();
const duration = Number(process.hrtime.bigint() - start) / 1e9;
const resultsPath = path.join(output, "results.json");
const metrics = fs.existsSync(resultsPath)
  ? JSON.parse(fs.readFileSync(resultsPath, "utf8"))
  : [];
if (!Array.isArray(metrics))
  throw new Error("results.json must contain an array of {name, unit, values}");
metrics.push({ name: "runner_elapsed", unit: "s", values: [duration] });
const manifest = {
  revision,
  dirty,
  command: commandText,
  hardware: context.hardware,
  environment: context.environment,
  workload: context.workload,
  configuration: context.configuration,
  startedAt,
  completedAt,
  outcome: exitCode === 0 ? "completed" : "failed",
};
write("manifest.json", manifest);
write("results.json", metrics);
const body = [
  context.body ?? "Interpretation pending.",
  `Command exit code: ${exitCode}.${failure ? ` Spawn error: ${failure}` : ""}`,
  "## Run context\n\n```json\n" + JSON.stringify(manifest, null, 2) + "\n```",
  "## Measurements\n\n```json\n" + JSON.stringify(metrics, null, 2) + "\n```",
].join("\n\n");
write("report.md", `# ${context.title}\n\n${body}\n`);
const capture = {
  id: `benchmark-${randomUUID()}`,
  expectedVersion: 0,
  title: context.title,
  body,
  threadId,
  artifacts: ["stdout.log", "stderr.log", "manifest.json", "results.json"].map(
    (name) => ({ name, path: path.join(output, name) }),
  ),
};
write("capture.json", JSON.stringify(capture) + "\n");
try {
  const receipt = execFileSync(
    "bb",
    ["knowledge", "save", "--input-stdin", "--json"],
    {
      input: JSON.stringify(capture),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  write("receipt.json", receipt);
  console.log(receipt);
} catch (error) {
  console.error(
    `Capture failed. Run files remain at ${output}. Retry using capture.json.\n${error.message}`,
  );
  process.exitCode = exitCode || 1;
}
process.exitCode ||= exitCode;
