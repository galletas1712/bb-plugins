# Live File Viewer

A BB file opener for `.md`, `.markdown`, `.html`, `.htm`, and `.svg`. Documents open in rendered preview by default; icon controls switch to editing or a resizable editor/preview split. A line-targeted open selects the editor and scrolls to the requested lines.

Previews show the last saved document and refresh only after a successful save or explicit reload from disk. Unsaved edits and view-mode switches do not restart the preview. The editor uses CodeMirror 6; other file extensions continue using their configured BB opener. The plugin uses public SDK APIs and does not replace BB's panel layout or inline visualization plugin.

## Install and choose the opener

From this directory:

```sh
npm ci
bb plugin build
bb plugin install .
```

In BB Settings → File openers, select **Live File Viewer** for the supported extensions. Explicit per-extension preferences take precedence over plugin registration order. For a one-off comparison, right-click a file link and select **Open with → Live File Viewer**. Reopen existing tabs to change their opener.

## Controls

All toolbar actions are icon buttons with hover tooltips and accessible labels. Editor mode also shows a Copy icon that copies the entire buffer, including unsaved changes; it briefly changes to a checkmark on success. Copy is hidden in Preview and Split modes:

| Icon                   | Action                                                        |
| ---------------------- | ------------------------------------------------------------- |
| Eye                    | Rendered preview                                              |
| Code                   | Editor                                                        |
| Columns                | Resizable editor/preview split                                |
| Save                   | Save, also Ctrl/⌘ S                                           |
| Counterclockwise arrow | Reload from disk, confirming before discarding edits          |
| Expand / contract      | Browser fullscreen / exit, where supported; Escape also exits |

BB's own panel maximize/restore control remains available. The split divider supports dragging and Left/Right arrow keys. The file name and save/read-only status appear beside the controls.

## Drafts, saving, and isolation

- Switching view modes preserves selection and undo history. In-memory sessions retain drafts and editor state across file-tab unmounts and reopening within the same browser session.
- Files save only on explicit Save. Saves use BB's compare-and-swap hash guard. If another process changed a file, the draft is retained and an error explains how to reconcile it; there is no silent overwrite.
- Edits made while a save is running remain dirty after that save completes.
- Reloading the browser discards in-memory drafts; a browser unload guard warns when editable documents are dirty. Drafts are not persisted to localStorage. Disabling/reloading the plugin also discards its in-memory sessions.
- Thread-storage artifacts remain read-only, matching BB's artifact contract. Workspace and explicitly addressed host files are editable. Files are capped at 5 MiB.
- HTML executes inside an opaque-origin iframe with `sandbox="allow-scripts"`; it cannot access BB's DOM or storage. Relative assets use a scoped BB preview URL renewed when saving or reloading (valid for one hour). External resources remain subject to browser policies. Each successful save restarts the document and its scripts; typing and switching view modes leave them unchanged.
- SVG previews use an image element, so embedded SVG scripts do not execute. Relative external SVG resources are not loaded from the data URL.
- Markdown uses BB's renderer. Workspace/thread-storage document context resolves local links; the current SDK does not offer that context for absolute host-file targets.
- Cached documents do not automatically reload when an agent changes the saved file. Use Reload from disk; Save detects external conflicts.

## Validate

```sh
npm run typecheck
npm test
npm run build
```

Tests use BB's official frontend/backend harnesses and a real CodeMirror editor under jsdom. They cover saved HTML/Markdown/SVG previews, sandbox attributes, selection and undo preservation, explicit saves, edits during saves, conflicts, tab-remount draft retention, reload confirmation, source/host routing, path confinement, and the public-SDK boundary. Browser layout and fullscreen still need a live BB smoke test.

Try [demo.html](examples/demo.html), [demo.md](examples/demo.md), and [demo.svg](examples/demo.svg).
