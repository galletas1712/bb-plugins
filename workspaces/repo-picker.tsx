import { useEffect, useRef, useState } from "react";
import {
  useRpc,
  type JsonValue,
  type PluginEnvironmentProviderInputsChange,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { rpcContract } from "./contract";
import { formatRepoSpec, isRepoSpec, parseRepoSpec } from "./repo-spec";

// Matches the composer's other environment options.
const TRIGGER_CLASS_NAME =
  "flex h-8 w-fit max-w-full min-w-0 items-center gap-1 rounded-md px-1 text-xs leading-tight text-muted-foreground";

/** The picked repos and their start points, as `<repo>[@<from>]` specs in `value`. */
function pickedRepos(value: JsonValue | null): Map<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(value.repos)) {
    return new Map();
  }
  const specs = value.repos.filter((spec): spec is string => typeof spec === "string");
  return new Map(specs.map((spec) => parseRepoSpec(spec)).map(({ name, from }) => [name, from ?? ""]));
}

/**
 * What the composer may submit. A lone repo is always chosen, picking none
 * makes an empty workspace, and an invalid start point blocks.
 */
export function decideInputs(args: {
  available: readonly string[] | null;
  picked: ReadonlyMap<string, string>;
  unavailableReason: string | null;
}): PluginEnvironmentProviderInputsChange {
  const { available, picked, unavailableReason } = args;
  if (unavailableReason !== null) return { status: "blocked", reason: unavailableReason };
  if (available === null) return { status: "blocked", reason: "Loading repos" };
  const chosen = available.length === 1 ? [...available] : available.filter((name) => picked.has(name));
  const repos = chosen.map((name) => formatRepoSpec({ name, from: picked.get(name)?.trim() || null }));
  const invalid = repos.find((spec) => !isRepoSpec(spec));
  return invalid === undefined
    ? { status: "ready", value: { repos } }
    : { status: "blocked", reason: `${invalid} is not a valid start point.` };
}

export function RepoPicker({ projectId, target, value, onChange }: PluginEnvironmentProviderInputsProps) {
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const rpc = useRpc<typeof rpcContract>();
  const scope = `${projectId}\n${hostId}`;
  const [listing, setListing] = useState<{
    scope: string;
    repos: string[] | null;
    error: string | null;
  } | null>(null);
  const [picked, setPicked] = useState(() => pickedRepos(value));
  const [attempt, setAttempt] = useState(0);
  const emitted = useRef("");

  useEffect(() => {
    if (projectId === null || hostId === null) return;
    let live = true;
    rpc.call("listRepos", { projectId, hostId }).then(
      ({ repos }) => live && setListing({ scope, repos, error: null }),
      (error: unknown) =>
        live &&
        setListing({
          scope,
          repos: null,
          error: `Could not list repos: ${error instanceof Error ? error.message : String(error)}`,
        }),
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId, hostId, scope, attempt]);

  const current = listing?.scope === scope ? listing : null;
  const available = current?.repos ?? null;
  const change = decideInputs({
    available,
    picked,
    unavailableReason:
      projectId === null || hostId === null
        ? "Workspaces need a project on an existing machine."
        : (current?.error ?? null),
  });
  const chosen = change.status === "ready" ? [...pickedRepos(change.value).keys()] : [...picked.keys()];
  const label = change.status === "ready" ? (change.value as { repos: string[] }).repos.join(", ") : "";

  useEffect(() => {
    const key = JSON.stringify(change);
    if (key === emitted.current) return;
    emitted.current = key;
    onChange(change);
  });

  if (current?.error) {
    return (
      <button
        type="button"
        className={cn(TRIGGER_CLASS_NAME, "hover:text-foreground")}
        title={current.error}
        onClick={() => setAttempt((count) => count + 1)}
      >
        <Icon name="AlertCircle" className="size-3.5 shrink-0" />
        <span className="truncate">Could not list repos. Retry</span>
      </button>
    );
  }

  if (available === null || available.length === 0) {
    return (
      <span className={TRIGGER_CLASS_NAME} title={change.status === "blocked" ? change.reason : undefined}>
        <Icon name="FolderGit" className="size-3.5 shrink-0" />
        <span className="truncate">{available === null && change.status === "blocked" ? change.reason : "No repos"}</span>
      </span>
    );
  }

  const update = (name: string, from: string | null) =>
    setPicked((previous) => {
      const next = new Map(previous);
      if (from === null) next.delete(name);
      else next.set(name, from);
      return next;
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(TRIGGER_CLASS_NAME, "hover:text-foreground")}
          title={change.status === "blocked" ? change.reason : label || "Empty workspace"}
        >
          <Icon name={change.status === "blocked" ? "AlertCircle" : "FolderGit"} className="size-3.5 shrink-0" />
          <span className={cn("min-w-0 truncate", label !== "" && "font-medium text-foreground")}>
            {change.status === "blocked" ? change.reason : label || "No repos"}
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        mobileTitle="Repos"
        className="max-h-[60vh] overflow-y-auto p-1 md:w-80"
      >
        {available.map((name) => {
          const on = chosen.includes(name);
          const from = picked.get(name) ?? "";
          return (
            <div key={name} className="rounded-sm px-2 py-1.5 hover:bg-accent">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={on}
                  disabled={available.length === 1}
                  onCheckedChange={(checked) => update(name, checked === true ? from : null)}
                />
                <span className="truncate">{name}</span>
              </label>
              {on && (
                <input
                  value={from}
                  onChange={(event) => update(name, event.target.value)}
                  placeholder="default branch, or branch, remote/branch, tag, sha, #pr"
                  spellCheck={false}
                  className={cn(
                    "mt-1 ml-6 h-7 w-[calc(100%-1.5rem)] rounded-md border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    from.trim() === "" || isRepoSpec(`${name}@${from.trim()}`) ? "border-input" : "border-destructive",
                  )}
                />
              )}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
