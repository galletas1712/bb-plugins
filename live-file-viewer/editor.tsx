import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type { DocumentSession } from "./document";
import { fileKind } from "./preview";

export function Editor({
  doc,
  save,
  lineRange,
}: {
  doc: DocumentSession;
  save: () => void;
  lineRange: PluginFileOpenerProps["experimental_lineRange"];
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!parent.current) return;
    const kind = fileKind(doc.request.path);
    const editor = new EditorView({
      parent: parent.current,
      dispatchTransactions(transactions, instance) {
        instance.update(transactions);
        doc.editorState = instance.state;
        if (transactions.some((t) => t.docChanged))
          doc.edit(instance.state.doc.toString());
      },
      state:
        doc.editorState ??
        EditorState.create({
          doc: doc.content,
          extensions: [
            basicSetup,
            kind === "html" ? html() : kind === "svg" ? xml() : markdown(),
            EditorView.lineWrapping,
            EditorState.readOnly.of(doc.readOnly),
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  saveRef.current();
                  return true;
                },
              },
              indentWithTab,
            ]),
            EditorView.contentAttributes.of({
              "aria-label": `Edit ${doc.request.path}`,
              spellcheck: "false",
            }),
            EditorView.theme({
              "&": {
                height: "100%",
                backgroundColor: "var(--background)",
                color: "var(--foreground)",
              },
              ".cm-scroller": {
                overflow: "auto",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "13px",
              },
              ".cm-gutters": {
                backgroundColor: "var(--background)",
                color: "var(--muted-foreground)",
                borderColor: "var(--border)",
              },
              ".cm-cursor": { borderLeftColor: "var(--foreground)" },
              ".cm-activeLine": {
                backgroundColor:
                  "color-mix(in srgb, var(--foreground) 5%, transparent)",
              },
            }),
          ],
        }),
    });
    view.current = editor;
    return () => {
      doc.editorState = editor.state;
      view.current = null;
      editor.destroy();
    };
  }, [doc]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== doc.content)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: doc.content },
      });
  }, [doc.content]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !lineRange) return;
    const start = Math.max(
      1,
      Math.min(lineRange.startLineNumber, editor.state.doc.lines),
    );
    const end = Math.max(
      start,
      Math.min(lineRange.endLineNumber, editor.state.doc.lines),
    );
    editor.dispatch({
      selection: {
        anchor: editor.state.doc.line(start).from,
        head: editor.state.doc.line(end).to,
      },
      scrollIntoView: true,
    });
    doc.setMode("editor");
    editor.focus();
  }, [doc, lineRange]);
  useEffect(() => {
    view.current?.requestMeasure();
  }, [doc.mode]);
  return <div ref={parent} className="lfv-editor" />;
}
