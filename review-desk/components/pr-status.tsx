import { Icon, type IconName } from "./ui/icon";
import { cn } from "../lib/utils";

interface PrStatusProps { state: string; isDraft?: boolean; merged?: boolean; reviewDecision?: string | null; className?: string }

function status({ state, isDraft, merged, reviewDecision }: PrStatusProps): { label: string; icon: IconName; tone: string } {
  if (merged || state === "MERGED") return { label: "Merged", icon: "GitMerge", tone: "text-purple-600 dark:text-purple-400" };
  if (state !== "OPEN") return { label: "Closed", icon: "GitPullRequestClosed", tone: "text-red-600 dark:text-red-400" };
  if (isDraft) return { label: "Draft", icon: "GitPullRequestDraft", tone: "text-muted-foreground" };
  return { label: reviewDecision === "APPROVED" ? "Approved" : "Open", icon: reviewDecision === "APPROVED" ? "Check" : "GitPullRequest", tone: "text-emerald-600 dark:text-emerald-400" };
}

export function PrMark(props: PrStatusProps) {
  const { label, icon, tone } = status(props);
  return <span role="img" aria-label={label} title={label} className={cn("inline-flex shrink-0", tone)}><Icon name={icon} className={cn("size-3.5", props.className)} /></span>;
}

export function StatePill(props: PrStatusProps) {
  const { label, icon, tone } = status(props);
  return <span className={cn("inline-flex items-center gap-1 rounded-full border border-current px-2 py-0.5 text-xs font-medium", tone)}><Icon name={icon} className="size-3" />{label}</span>;
}
