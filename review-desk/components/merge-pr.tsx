import { useCallback, useEffect, useState } from "react";
import { UrlLink, useBbNavigate, useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { queryClient, reviewKey } from "../lib/query-client";
import type { Review, rpcContract } from "../server";
import type { MergeOptions, MergeResult } from "../merge-contract";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

type Method = MergeOptions["methods"][number];
const mergeMethodLabels = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const selectedMethod = (options: MergeOptions | null, choice: Method | null): Method => choice && options?.methods.includes(choice) ? choice : options?.defaultMethod ?? "merge";

export function MergePr({ review, compact = false }: { review: Review; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const key = reviewKey(review.id, "merge");
  const query = useQuery({ queryKey: key, queryFn: () => rpc.call("review_merge_options", { reviewId: review.id }) });
  useRealtime("review-changed", (payload) => {
    if (payload && typeof payload === "object" && "reviewId" in payload && payload.reviewId === review.id && "what" in payload && payload.what === "merge-options") void query.refetch();
  });
  const options = query.data ?? null;
  const [choice, setChoice] = useState<Method | null>(null);
  const [confirmation, setConfirmation] = useState<{ options: MergeOptions; method: Method } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const load = useCallback(async () => {
    const next = await rpc.call("review_merge_options", { reviewId: review.id, refresh: true });
    await queryClient.cancelQueries({ queryKey: reviewKey(review.id, "merge") });
    queryClient.setQueryData(reviewKey(review.id, "merge"), next);
    setError(null);
    return next;
  }, [rpc, review.id]);
  useEffect(() => {
    const refresh = () => { void query.refetch(); };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 15_000);
    return () => { clearInterval(timer); };
  }, [query.refetch, review.headSha, review.ghUpdatedAt, review.isDraft]);
  useEffect(() => {
    if (result?.status !== "pending" || !result.requestId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await rpc.call("review_merge_result", { reviewId: review.id, requestId: result.requestId! });
        if (!active) return;
        setError(null);
        setResult(next);
        if (next.status !== "pending") return;
      } catch (cause) { if (active) setError(message(cause)); }
      if (active) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [rpc, review.id, result?.status, result?.requestId]);
  useEffect(() => {
    if (result?.status === "merged") {
      toast.success("Pull request merged");
      navigate.toPluginPanel("reviews");
    }
  }, [result?.status, navigate]);
  const pending = result?.status === "pending";
  const failure = error ?? (!options && query.error ? message(query.error) : null);
  const method = selectedMethod(options, choice);
  const hasChoices = options !== null && options.methods.length > 1;
  const reason = options?.reason ?? (options && options.headSha !== review.headSha ? "Refresh the PR to review its latest changes before merging." : null);
  const label = mergeMethodLabels[method];
  const prepare = async () => {
    setBusy(true);
    try {
      const next = await load();
      const method = selectedMethod(next, choice);
      if (!next.reason && next.headSha === review.headSha && next.methods.includes(method)) setConfirmation({ options: next, method });
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const merge = async () => {
    if (!confirmation) return;
    setBusy(true); setError(null);
    try {
      setResult(await rpc.call("review_merge", { reviewId: review.id, method: confirmation.method, expected: {
        headSha: confirmation.options.headSha, baseRefName: confirmation.options.baseRefName, prs: confirmation.options.prs,
      } }));
      setConfirmation(null);
    } catch (cause) { setError(message(cause)); setConfirmation(null); }
    finally { setBusy(false); }
  };
  return <div className="relative flex items-center" role="group" aria-label="Merge pull request" title={reason ?? undefined}>
    <Button size="sm" className={`bg-emerald-700 text-white hover:bg-emerald-800 ${hasChoices ? "rounded-r-none" : ""}`} disabled={!options || Boolean(reason) || busy || pending || confirmation !== null || result?.status === "enqueued"} title={reason ?? undefined} onClick={() => void prepare()}>{pending ? "Merging…" : options ? label : "Merge"}{!compact && !pending && options && options.prs.length > 1 ? ` ${options.prs.length} PRs` : ""}</Button>
    {hasChoices ? <span className="relative inline-flex">
      <select aria-label="Merge method" title="Choose merge method" value={method} disabled={busy || pending || confirmation !== null} onChange={(event) => { setChoice(event.target.value as Method); setConfirmation(null); }} className="h-8 w-7 cursor-pointer appearance-none rounded-r-md border-l border-white/30 bg-emerald-700 text-transparent hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        {options.methods.map((method) => <option key={method} value={method} className="bg-background text-foreground">{mergeMethodLabels[method]}</option>)}
      </select><Icon name="ChevronDown" className="pointer-events-none absolute left-1.5 top-2 size-3.5 text-white" />
    </span> : null}
    {failure || result?.status === "failed" || result?.status === "enqueued" ? <div role={result?.status === "enqueued" ? "status" : "alert"} className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-3 text-xs shadow-lg">
      {failure ?? (result?.status === "enqueued" ? "Queued on GitHub. Waiting to merge." : result?.message || "GitHub could not merge this pull request.")}
      {!pending ? <button type="button" className="ml-2 underline" onClick={() => { setResult(null); void load().catch((cause) => setError(message(cause))); }}>Refresh</button> : null}
    </div> : null}
    {confirmation ? <section aria-label="Confirm merge" className="absolute right-0 top-full z-50 mt-2 w-[min(26rem,calc(100vw-2rem))] space-y-2 rounded-md border border-border bg-card p-3 text-xs shadow-lg">
      <p>{mergeMethodLabels[confirmation.method]} {confirmation.options.prs.map((pr) => "#" + pr.number).join(", ")} into <strong>{confirmation.options.baseRefName}</strong>.</p>
      {confirmation.options.prs.length > 1 ? <p>This includes {confirmation.options.prs.length} open PRs through this layer of the stack.</p> : null}
      <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void merge()}>Confirm {mergeMethodLabels[confirmation.method].toLowerCase()}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button><UrlLink href={review.url} className="self-center text-muted-foreground underline">View on GitHub</UrlLink></div>
    </section> : null}
  </div>;
}
