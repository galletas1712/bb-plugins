import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { completeWithClaude, type Complete } from "./claude";
import { describeOutcome, retitle, type RetitleDeps } from "./retitle";

export default function plugin(bb: BbPluginApi, options: { complete?: Complete } = {}) {
  const settings = bb.settings.define({
    model: {
      type: "string",
      label: "Model",
      description: "Claude model alias or id passed to `claude -p --model`. `haiku` costs about 4× less but decides less consistently.",
      default: "sonnet",
    },
  });
  const deps: RetitleDeps = {
    sdk: bb.sdk,
    pluginId: bb.pluginId,
    complete:
      options.complete ??
      (async (prompt, signal) => completeWithClaude((await settings.get()).model, prompt, signal)),
  };
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());

  // Threads that received a human message since their last check. Tool calls
  // and agent- or system-initiated turns never land here.
  const awaitingCheck = new Set<string>();
  const running = new Set<string>();
  const rerun = new Set<string>();

  async function check(threadId: string) {
    if (running.has(threadId)) {
      rerun.add(threadId);
      return;
    }
    running.add(threadId);
    try {
      do {
        rerun.delete(threadId);
        try {
          const outcome = await retitle(deps, threadId, { apply: true, signal: lifetime.signal });
          bb.log.info(`${threadId}: ${describeOutcome(outcome)}`);
        } catch (error) {
          if (lifetime.signal.aborted) return;
          bb.log.warn(`${threadId}: retitle failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (rerun.has(threadId));
    } finally {
      running.delete(threadId);
    }
  }

  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    if (ctx.initiator === "user" || ctx.initiator === "mixed") awaitingCheck.add(ctx.thread.id);
    return { action: "proceed" };
  });

  // Checking once the turn settles lets the model see the reply too, and
  // collapses several messages sent during one turn into a single check.
  bb.events.on("thread.idle", ({ thread }) => {
    if (awaitingCheck.delete(thread.id)) void check(thread.id);
  });

  bb.cli.register(
    defineCli({
      name: "retitle",
      summary: "Check whether a thread's title still fits its conversation",
      commands: {
        check: cliCommand({
          summary: "Ask the title model about one thread. Dry run unless --apply",
          positionals: [{ name: "thread-id", description: "Thread to check. Defaults to the current thread." }],
          options: {
            apply: {
              type: "boolean",
              description: "Write the proposed title. Also clears a manual-rename lock.",
            },
            json: { type: "boolean", description: "Emit the outcome as JSON" },
          },
          async run(input, ctx) {
            const threadId = input.positionals["thread-id"] ?? ctx.threadId;
            if (!threadId) {
              throw new PluginCliError("no thread to check", {
                code: "thread_required",
                hint: "Pass a thread id: `bb retitle check thr_...`",
              });
            }
            const apply = input.options.apply === true;
            const outcome = await retitle(deps, threadId, { apply, force: apply, signal: ctx.signal });
            const stdout = input.options.json ? JSON.stringify(outcome) : describeOutcome(outcome);
            return { exitCode: 0, stdout: `${stdout}\n` };
          },
        }),
      },
    }),
  );
}
