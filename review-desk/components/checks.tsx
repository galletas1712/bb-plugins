import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { Review } from "../server";
import { Icon } from "./ui/icon";

type Check = Review["checks"][number];
function checkState(check: Check) {
  const state = (check.conclusion || check.status).toLowerCase();
  if (["success", "skipped", "neutral"].includes(state)) return { kind: "passed", label: state, icon: "Check", tone: "text-emerald-600 dark:text-emerald-400" } as const;
  if (["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(state)) return { kind: "failed", label: state.replace(/_/g, " "), icon: "X", tone: "text-red-600 dark:text-red-400" } as const;
  return { kind: "pending", label: state.replace(/_/g, " "), icon: "Loading", tone: "text-amber-600 dark:text-amber-400" } as const;
}

export function Checks({ review }: { review: Review }) {
  const checks = review.checks.map((check) => ({ ...check, ...checkState(check) }));
  const failed = checks.filter((check) => check.kind === "failed").length;
  const pending = checks.filter((check) => check.kind === "pending").length;
  const passed = checks.length - failed - pending;
  const summary = checks.length === 0 ? "No checks reported" : failed > 0 ? "Some checks were not successful" : pending > 0 ? "Some checks are pending" : "All checks have passed";
  const status = checkState({ name: "", status: checks.length === 0 ? "unknown" : failed ? "failure" : pending ? "pending" : "success", conclusion: null, url: null });
  return <section aria-label="Checks" className="overflow-hidden rounded-md border border-border bg-card">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted/30 px-4 py-2 text-xs">
      <span className="font-semibold">Checks</span><span className="text-muted-foreground">on latest commit</span>
      <UrlLink href={`https://github.com/${review.owner}/${review.repo}/commit/${review.headSha}`} title={review.headSha} className="font-mono text-muted-foreground hover:underline">{review.headSha.slice(0, 7)}</UrlLink>
      <UrlLink href={`${review.url}/checks`} className="ml-auto text-muted-foreground hover:underline">View on GitHub</UrlLink>
    </div>
    <details className="group/checks">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <Icon name={checks.length === 0 ? "Code" : status.icon} className={`size-5 shrink-0 ${checks.length === 0 ? "text-muted-foreground" : status.tone}`} />
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{summary}</span>
          {checks.length > 0 ? <span className="block text-xs text-muted-foreground">{[failed ? `${failed} unsuccessful` : "", pending ? `${pending} pending` : "", passed ? `${passed} successful` : ""].filter(Boolean).join(", ")}</span> : null}
        </span>
        <Icon name="ChevronRight" className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/checks:rotate-90" />
      </summary>
      {checks.length > 0 ? <ul className="divide-y divide-border border-t border-border">{checks.map((check, index) => <li key={index} className="flex items-center gap-3 px-4 py-2 text-xs">
        <Icon name={check.icon} className={`size-3.5 shrink-0 ${check.tone}`} />
        <span className="min-w-0 flex-1 break-words">{check.name}</span>
        <span className={`shrink-0 ${check.tone}`}>{check.label}</span>
        {check.url ? <UrlLink href={check.url} className="shrink-0 text-muted-foreground hover:underline" aria-label={`Details for ${check.name}`}>Details</UrlLink> : null}
      </li>)}</ul> : null}
    </details>
  </section>;
}
