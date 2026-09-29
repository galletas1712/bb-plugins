# Live File Viewer

This plugin supplies a `fileOpener` for Markdown, HTML, and SVG. It does not register a sidebar replacement or alter inline-vis.

- `app.tsx` owns accessible icon controls, modes, split resizing, reload confirmation, and browser fullscreen.
- `document.ts` owns in-memory draft sessions and race-safe, conflict-checked saves.
- `editor.tsx` embeds CodeMirror with retained editor state and line navigation.
- `preview.tsx` renders the saved document using BB Markdown, a sandboxed HTML iframe, or an SVG image.
- `contract.ts`, `target.ts`, and `server.ts` validate RPC input, resolve the source's host/path, and use `bb.sdk.files` for reads, writes, and scoped asset URLs.

No external account or plugin dependency is required. Disable or unselect this plugin to return to BB's built-in preview or File Editor. See README.md for limitations and tests.
