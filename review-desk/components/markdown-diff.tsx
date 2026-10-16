import { useMemo } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { diffMarkdown, type MarkdownBlock } from "../lib/markdown-diff";
import { cn } from "../lib/utils";

interface MarkdownDiffProps {
  oldContent: string;
  newContent: string;
  diffStyle: "unified" | "split";
  className?: string;
  onSource(side: "deletions" | "additions", block: MarkdownBlock): void;
}

export function MarkdownDiff({ oldContent, newContent, diffStyle, className, onSource }: MarkdownDiffProps) {
  const changes = useMemo(() => diffMarkdown(oldContent, newContent), [oldContent, newContent]);
  const split = diffStyle === "split";
  const renderBlocks = (blocks: MarkdownBlock[], side: "deletions" | "additions", changed: boolean) => (
    <div className="min-w-0">
      {blocks.map((block, index) => (
        <div key={index} data-source-side={side} data-source-start={block.startLine} data-source-end={block.endLine}
          aria-label={changed ? side === "deletions" ? "Removed content" : "Added content" : undefined}
          className={cn("group relative px-4 py-2", changed && (side === "deletions" ? "border-l-2 border-red-500/60 bg-red-500/10" : "border-l-2 border-green-500/60 bg-green-500/10"))}>
            <button type="button" className="absolute right-1 top-1 z-10 rounded bg-background/90 px-1 font-mono text-[10px] text-muted-foreground opacity-0 hover:underline focus-visible:opacity-100 group-hover:opacity-100" onClick={() => onSource(side, block)} aria-label={`Open ${side === "deletions" ? "old" : "new"} source lines ${block.startLine} to ${block.endLine}`}>
              L{block.startLine}{block.endLine !== block.startLine ? `–${block.endLine}` : ""}
            </button>
          <Markdown content={block.content} className={cn(className, "text-sm")} />
        </div>
      ))}
    </div>
  );
  return (
    <div aria-label="Rendered Markdown diff">
      {split ? <div className="grid grid-cols-2 border-b border-border text-xs text-muted-foreground"><span className="px-4 py-2">Before</span><span className="border-l border-border px-4 py-2">After</span></div> : null}
      {changes.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">No rendered content. Use Source to review the changes.</p> : null}
      {changes.map((change, index) => (
        <div key={index} className={cn("border-b border-border/60 last:border-b-0", split && "grid grid-cols-2 divide-x divide-border/60")}>
          {split || change.changed ? renderBlocks(change.old, "deletions", change.changed) : null}
          {renderBlocks(change.new, "additions", change.changed)}
        </div>
      ))}
    </div>
  );
}
