import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ReviewSummary, rpcContract } from "../server";
import { queryClient, reviewKey } from "../lib/query-client";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

type Pr = Pick<ReviewSummary, "id" | "owner" | "repo" | "number" | "state" | "isDraft"> & { url?: string };

export function PrActions({ pr, compact = false, onClosed }: { pr: Pr; compact?: boolean; onClosed?(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pr.url ?? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`);
      toast.success("GitHub link copied");
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
  };
  const act = async (action: "close" | "ready") => {
    if (action === "close" && !window.confirm(`Close ${pr.owner}/${pr.repo}#${pr.number} on GitHub?`)) return;
    setBusy(true);
    try {
      await rpc.call("pr_action", { owner: pr.owner, repo: pr.repo, number: pr.number, action });
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
      if (pr.id) void queryClient.invalidateQueries({ queryKey: reviewKey(pr.id) });
      toast.success(action === "close" ? "Pull request closed" : "Pull request marked ready for review");
      if (action === "close") onClosed?.();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const buttonClass = compact ? "h-7 w-7 shrink-0 px-0" : "h-7 gap-1.5 px-2 text-xs";
  return <div role="group" aria-label={`Pull request actions for #${pr.number}`} className="flex flex-wrap items-center gap-1">
    <Button type="button" variant="ghost" size="sm" className={buttonClass} aria-label={`Copy GitHub link for #${pr.number}`} title="Copy GitHub link" onClick={() => void copy()}>
      <Icon name="Copy" className="size-3.5" />{!compact ? "Copy link" : null}
    </Button>
    {pr.state === "OPEN" ? <>
      {pr.isDraft ? <Button type="button" variant="ghost" size="sm" className={buttonClass} disabled={busy} aria-label={`Mark #${pr.number} ready for review`} title="Mark ready for review" onClick={() => void act("ready")}>
        <Icon name="GitPullRequestArrow" className="size-3.5" />{!compact ? "Mark ready" : null}
      </Button> : null}
      <Button type="button" variant="ghost" size="sm" className={`${buttonClass} text-muted-foreground hover:text-destructive`} disabled={busy} aria-label={`Close PR #${pr.number}`} title="Close PR" onClick={() => void act("close")}>
        <Icon name="GitPullRequestClosed" className="size-3.5" />{!compact ? "Close PR" : null}
      </Button>
    </> : null}
  </div>;
}
