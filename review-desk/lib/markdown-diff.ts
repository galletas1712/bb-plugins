import { diffArrays } from "diff";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";

export interface MarkdownBlock {
  content: string;
  startLine: number;
  endLine: number;
}

export interface MarkdownChange {
  changed: boolean;
  old: MarkdownBlock[];
  new: MarkdownBlock[];
}

function visit(node: Nodes, callback: (node: Nodes) => void): void {
  callback(node);
  if ("children" in node) for (const child of node.children) visit(child, callback);
}

function blocks(text: string): MarkdownBlock[] {
  const source = text.replace(/\r\n?/g, "\n");
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, Nodes>();
  const raw = (node: Nodes) => source.slice(node.position!.start.offset!, node.position!.end.offset!);
  visit(tree, (node) => {
    if (node.type !== "definition" && node.type !== "footnoteDefinition") return;
    const key = `${node.type}:${node.identifier}`;
    if (!definitions.has(key)) definitions.set(key, node);
  });
  return tree.children.filter((node) => node.type !== "definition" && node.type !== "footnoteDefinition").map((node) => {
    // Each block renders alone. Carry its referenced definitions with it, so
    // changing a link target or footnote also marks the block as changed.
    const context = new Map<string, string>();
    const collect = (child: Nodes) => {
      const type = child.type === "footnoteReference" ? "footnoteDefinition"
        : child.type === "linkReference" || child.type === "imageReference" ? "definition" : null;
      if (type === null || !("identifier" in child)) return;
      const key = `${type}:${child.identifier}`;
      const definition = definitions.get(key);
      if (definition === undefined || context.has(key)) return;
      context.set(key, raw(definition));
      visit(definition, collect);
    };
    visit(node, collect);
    const content = [raw(node), ...[...context].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)].join("\n\n");
    return { content, startLine: node.position!.start.line, endLine: node.position!.end.line };
  });
}

/** Compare whole Markdown blocks so tables, lists, and fences stay renderable. */
export function diffMarkdown(oldContent: string, newContent: string): MarkdownChange[] {
  const oldBlocks = blocks(oldContent);
  const newBlocks = blocks(newContent);
  const changes = diffArrays(oldBlocks, newBlocks, { comparator: (a, b) => a.content === b.content, timeout: 100 });
  if (changes === undefined) return [{ changed: true, old: oldBlocks, new: newBlocks }];
  const result: MarkdownChange[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const change of changes) {
    const count = change.value.length;
    const changed = Boolean(change.added || change.removed);
    const old = change.added ? [] : oldBlocks.slice(oldIndex, oldIndex + count);
    const next = change.removed ? [] : newBlocks.slice(newIndex, newIndex + count);
    if (!change.added) oldIndex += count;
    if (!change.removed) newIndex += count;
    const previous = result.at(-1);
    if (changed && previous?.changed) {
      previous.old.push(...old);
      previous.new.push(...next);
    } else result.push({ changed, old, new: next });
  }
  return result;
}
