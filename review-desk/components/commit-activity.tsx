import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { GhEvent } from "../host-contract";
import { Icon } from "./ui/icon";

export function CommitActivity({ events, timeAgo }: { events: GhEvent[]; timeAgo(when: string): string }) {
  const authors = [...new Set(events.map((event) => event.actor).filter(Boolean))];
  const latest = events.at(-1)!;
  const forcePushed = events.some((event) => event.event === "head_ref_force_pushed");
  const hashes = [...new Map(events.filter((event) => event.sha).map((event) => [event.sha, event])).values()].slice(-3);
  return <div className="flex items-start gap-3 text-xs text-muted-foreground">
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted"><Icon name="GitCommit" className="size-3.5" /></span>
    <div className="min-w-0 flex-1 py-1">
      <details className="group/commits">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 [&::-webkit-details-marker]:hidden">
          <Icon name="ChevronRight" className="size-3 shrink-0 transition-transform group-open/commits:rotate-90" />
          <span className="font-medium text-foreground">{authors.length === 1 ? authors[0] : authors.length > 1 ? `${authors.length} contributors` : "Someone"}</span>
          <span>{forcePushed ? `updated the branch (${events.length} ${events.length === 1 ? "update" : "updates"}, including a force-push)` : `added ${events.length} ${events.length === 1 ? "commit" : "commits"}`}</span>
          {latest.createdAt ? <time dateTime={latest.createdAt} title={latest.createdAt}>{timeAgo(latest.createdAt)}</time> : null}
        </summary>
        <ul className="mt-3 space-y-2 border-l border-border pl-4">{events.map((event) => <li key={event.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1 break-words text-foreground">{event.event === "head_ref_force_pushed" ? "Force-pushed the branch" : event.details.split("\n")[0] || "Commit"}</span>
          {event.actor ? <span>{event.actor}</span> : null}
          {event.createdAt ? <time dateTime={event.createdAt} title={event.createdAt}>{timeAgo(event.createdAt)}</time> : null}
          {event.url ? <UrlLink href={event.url} title={event.sha ?? undefined} className="font-mono hover:underline">{event.sha?.slice(0, 7) ?? "GitHub"}</UrlLink> : event.sha ? <code>{event.sha.slice(0, 7)}</code> : null}
        </li>)}</ul>
      </details>
      {hashes.length > 0 ? <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-5"><span>Latest {hashes.length === 1 ? "commit" : "commits"}</span>{hashes.map((event) => event.url ? <UrlLink key={event.sha} href={event.url} title={event.sha!} className="font-mono hover:underline">{event.sha!.slice(0, 7)}</UrlLink> : <code key={event.sha}>{event.sha!.slice(0, 7)}</code>)}</div> : null}
    </div>
  </div>;
}
