import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderCreateResult } from "@get-bb/plugin-sdk/environment-provider";
import { hostContract, inputsSchema, rpcContract } from "./contract.js";
import { formatRepoSpec, isRepoSpec, parseRepoSpec, type RepoEntry } from "./repo-spec.js";
import { PROVIDER_ID } from "./provider-id.js";
import { keyedQueue } from "./queue.js";

// Fetching and checking out large repos (TensorRT-LLM, pytorch) takes minutes.
const PROVISION_TIMEOUT_MS = 30 * 60_000;
const SCAN_TIMEOUT_MS = 60_000;
// One git status per repo, a few at a time, for folders of dozens of repos.
const CHANGES_TIMEOUT_MS = 60_000;

/**
 * What a workspace holds, stored per pathKey. Kept after removal, because
 * restore runs then, and kept after thread deletion, because forks can
 * share the environment.
 */
interface WorkspaceState {
  projectPath: string;
  branch: string;
  repos: RepoEntry[];
}

const stateKey = (pathKey: string) => `workspace:${pathKey}`;
const selectionKey = (projectId: string) => `selection:${projectId}`;

interface ProjectSelection {
  createdAt: number;
  pathKey: string;
  repos: string[];
}

export default async function workspacesPlugin(bb: BbPluginApi): Promise<void> {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;
  // Adds to one workspace run one at a time so neither overwrites the other's repo list.
  const perWorkspace = keyedQueue();
  const perProject = keyedQueue();

  async function rememberSelection(projectId: string, selection: ProjectSelection) {
    await perProject(projectId, async () => {
      const previous = await kv.get<ProjectSelection>(selectionKey(projectId));
      if (previous === undefined || selection.createdAt > previous.createdAt ||
          (selection.createdAt === previous.createdAt && selection.pathKey > previous.pathKey)) {
        await kv.set(selectionKey(projectId), selection);
      }
    });
  }

  async function previousSelection(projectId: string): Promise<string[] | null> {
    const saved = await kv.get<ProjectSelection>(selectionKey(projectId));
    if (saved !== undefined) return saved.repos;

    // Existing environments retain their original provider inputs. Use the
    // latest completed one until this project creates a workspace with this version.
    let latest: { createdAt: number; repos: string[] } | null = null;
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = await bb.sdk.environments.list({ projectId, environmentProviderId: PROVIDER_ID, limit, offset });
      for (const environment of page) {
        if (environment.status !== "ready" && environment.status !== "destroyed") continue;
        const parsed = inputsSchema.safeParse(environment.environmentProviderSelection?.inputs);
        if (parsed.success && (latest === null || environment.createdAt > latest.createdAt)) {
          latest = { createdAt: environment.createdAt, repos: parsed.data.repos };
        }
      }
      if (page.length < limit) return latest?.repos ?? null;
    }
  }

  function ensure(hostId: string, pathKey: string, state: WorkspaceState, signal?: AbortSignal) {
    return host.call("ensure", { pathKey, ...state }, { hostId, signal, timeoutMs: PROVISION_TIMEOUT_MS });
  }

  async function created(
    signal: AbortSignal,
    run: () => Promise<{ path: string }>,
  ): Promise<PluginEnvironmentProviderCreateResult> {
    try {
      const { path } = await run();
      return { status: "created", path, ownsPath: true };
    } catch (error) {
      if (signal.aborted) throw error;
      return { status: "failed", message: messageOf(error) };
    }
  }

  bb.experimental_environments.register({
    id: PROVIDER_ID,
    displayName: "Workspace",
    description: "Worktrees of the repos you pick, in a folder that is not itself a repo.",
    icon: "FolderGit",
    requires: { projectCheckout: true },
    inputs: inputsSchema,
    policy: { pathKeys: "per-attempt" },
    create: (context) =>
      created(context.signal, async () => {
        // A re-called create keeps the branch it started with, even if the
        // thread's title, and so its suggested branch name, changed since.
        let state = await kv.get<WorkspaceState>(stateKey(context.pathKey));
        if (state === undefined) {
          const projectPath = context.projectCheckout.path;
          const { branch } = await host.call(
            "branch",
            { projectPath, suggested: context.suggestedBranchName },
            { hostId: context.host.id, signal: context.signal, timeoutMs: SCAN_TIMEOUT_MS },
          );
          state = { projectPath, branch, repos: context.inputs.repos.map(parseRepoSpec) };
          await kv.set(stateKey(context.pathKey), state);
        }
        if (state.repos.length > 0) context.report.step(`Fetching ${state.repos.map(formatRepoSpec).join(", ")}`);
        const result = await ensure(context.host.id, context.pathKey, state, context.signal);
        await rememberSelection(context.project.id, {
          createdAt: context.thread.createdAt,
          pathKey: context.pathKey,
          repos: state.repos.map(formatRepoSpec),
        });
        return result;
      }),
    restore: (context) =>
      created(context.signal, async () => {
        const previousKey = context.previous.environment.environmentProviderInstanceKey;
        const previous =
          previousKey === null ? undefined : await kv.get<WorkspaceState>(stateKey(previousKey));
        if (previous === undefined) {
          throw new Error("This workspace's repo list was not saved, so it cannot be restored.");
        }
        const state = { ...previous, projectPath: context.projectCheckout.path };
        await kv.set(stateKey(context.pathKey), state);
        if (state.repos.length > 0) context.report.step(`Recreating ${state.repos.map(({ name }) => name).join(", ")}`);
        return ensure(context.host.id, context.pathKey, state, context.signal);
      }),
    async remove(context) {
      if (context.hostId === null) {
        return { status: "failed", message: "The workspace's machine is unknown." };
      }
      try {
        await host.call(
          "remove",
          { pathKey: context.pathKey },
          { hostId: context.hostId, signal: context.signal, timeoutMs: PROVISION_TIMEOUT_MS },
        );
        return { status: "removed" };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: messageOf(error) };
      }
    },
  });

  /** The thread's environment while its folder exists, or null. */
  async function readyEnvironment(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const { path } = environment;
    return environment.status === "ready" && path !== null ? { ...environment, path } : null;
  }

  bb.rpc.register(rpcContract, {
    async listRepos({ projectId, hostId }) {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources.find(
        (candidate) => candidate.hostId === hostId && candidate.type === "local_path",
      );
      const [listing, previous] = await Promise.all([
        source === undefined
          ? Promise.resolve({ repos: [] })
          : host.call("scan", { projectPath: source.path }, { hostId, timeoutMs: SCAN_TIMEOUT_MS }),
        previousSelection(projectId),
      ]);
      return { ...listing, previous };
    },
    async changes({ threadId, mode }) {
      const environment = await readyEnvironment(threadId);
      if (environment === null) {
        return { status: "unavailable" as const, reason: "This thread has no workspace folder right now." };
      }
      const { repos } = await host.call(
        "changes",
        { root: environment.path, mode },
        { hostId: environment.hostId, timeoutMs: CHANGES_TIMEOUT_MS },
      );
      return { status: "ready" as const, repos };
    },
    async diff({ threadId, ...file }) {
      const environment = await readyEnvironment(threadId);
      if (environment === null) throw new Error("This thread has no workspace folder right now.");
      return host.call(
        "diff",
        { root: environment.path, ...file },
        { hostId: environment.hostId, timeoutMs: CHANGES_TIMEOUT_MS },
      );
    },
  });

  bb.cli.register(
    defineCli({
      name: "workspaces",
      summary: "Add repos to a thread's workspace",
      commands: {
        add: cliCommand({
          summary: "Add repos from the project to this thread's workspace",
          description:
            "Adds a worktree for each repo on the thread's branch, started from a fresh fetch of the repo's upstream default branch, or from <start> when given as <repo>@<start>. A start is a branch, <remote>/<branch>, a tag, a full commit id, #<pr>, or <remote>#<pr>. Repos already in the workspace are left alone.",
          positionals: [
            {
              name: "repos",
              description: "Repo folder names from the project, each optionally as <repo>@<start>",
              required: true,
              variadic: true,
            },
          ],
          options: {
            thread: {
              type: "string",
              description: "Thread whose workspace to change. Defaults to the current thread.",
            },
          },
          async run(input, context) {
            const threadId = input.options.thread ?? context.threadId;
            if (threadId === undefined) {
              throw new PluginCliError("No thread to add repos to.", {
                code: "thread_required",
                hint: "Run this from an agent's shell, or pass --thread <thread-id>.",
              });
            }
            try {
              const lines = await addRepos(threadId, input.positionals.repos);
              return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
            } catch (error) {
              if (error instanceof PluginCliError) throw error;
              throw new PluginCliError(messageOf(error), { code: "add_failed" });
            }
          },
        }),
      },
    }),
  );

  /**
   * Adds repos to a thread's workspace. It takes no abort signal: a slow
   * fetch keeps going after the caller's shell gives up, and a later call
   * finds the repo already added.
   */
  async function addRepos(threadId: string, specs: string[]): Promise<string[]> {
    const invalid = specs.filter((spec) => !isRepoSpec(spec));
    if (invalid.length > 0) {
      throw new PluginCliError(`Not a repo or <repo>@<start>: ${invalid.join(", ")}`, { code: "invalid_repo" });
    }
    const environment = await readyEnvironment(threadId);
    if (environment === null || environment.lifecycle.phase !== "active") {
      throw new PluginCliError(`Thread ${threadId} has no active workspace folder.`, {
        code: "workspace_inactive",
      });
    }
    const pathKey = environment.environmentProviderInstanceKey;
    if (environment.environmentProviderId !== PROVIDER_ID || pathKey === null) {
      throw new PluginCliError(`Thread ${threadId} does not run in a Workspaces environment.`, {
        code: "not_a_workspace",
      });
    }
    return perWorkspace(pathKey, async () => {
      const state = await kv.get<WorkspaceState>(stateKey(pathKey));
      if (state === undefined) {
        throw new PluginCliError("This workspace's repo list was not saved.", { code: "state_missing" });
      }
      // A repo already listed keeps its entry, so its recorded start stays true.
      const repos = [...state.repos];
      for (const entry of specs.map(parseRepoSpec)) {
        if (!repos.some(({ name }) => name === entry.name)) repos.push(entry);
      }
      const next = { ...state, repos };
      const result = await ensure(environment.hostId, pathKey, next);
      await kv.set(stateKey(pathKey), next);
      const names = [...new Set(specs.map((spec) => parseRepoSpec(spec).name))];
      return names.map((name) =>
        result.created.includes(name)
          ? `Added ${name} at ${result.path}/${name} on branch ${state.branch}. Read ${name}/AGENTS.md or CLAUDE.md if present.`
          : `${name} is already in the workspace at ${result.path}/${name}. Its start point is unchanged.`,
      );
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
