# Knowledge

A file library for agent context and evidence, with a thread **Explainers** panel
for readers. The panel lists short titles. Select one to read it, then go Back to
the list. Agents manage preservation and reuse. The existing Knowledge page is
available for record maintenance.

## Install

Requires BB 0.48.1+, Plugin SDK 0.6.104+, Node 22+, and QMD 2.8.3+ on the BB server.
Install from a persistent directory so workspace retirement cannot remove it.

```sh
npm install -g @tobilu/qmd
cd knowledge
npm install --include=dev
bb plugin build
bb plugin install . --yes
```

If QMD is outside the server's PATH, set `qmdExecutable` to its absolute path
with `bb plugin config knowledge set qmdExecutable /path/to/qmd`, then reload.
The library defaults to `~/.local/share/bb-knowledge` on the server. Set
`libraryPath` and reload to select another directory. This does not move files.
Back up the library. Uninstalling preserves library files.

## Save and present

The [knowledge-library skill](skills/knowledge-library/SKILL.md) guides recall,
maintenance, and visual authoring. Knowledge contributes a short instruction for
publishing saved visuals in Explainers.
Agents create or reuse an explainer for a requested visual or when a visual would
substantially clarify the answer. Routine updates and simple answers stay in chat.
Preserving useful Knowledge does not require creating an explainer.
New instructions take effect when a provider session is next constructed.
For an Explainers-only setup, disable the competing inline-vis plugin:

```sh
bb plugin disable inline-vis
```

This removes its skill from future agent configurations and stops rendering
historic inline-vis blocks. Existing messages and saved files remain intact.
Already loaded instructions remain until the provider session is restarted.

Native tools are `knowledge_recall`, `knowledge_save`, and `knowledge_delete`.
The CLI also reads records:

```sh
bb knowledge search "worker reconnect" --json
bb knowledge read worker-reconnect --json
bb knowledge save capture.json
```

Create a record and show a self-contained HTML document in the calling thread:

```json
{
  "id": "request-handoff",
  "title": "Request handoff",
  "body": "The coordinator hands requests to workers. overview.html explains the lifecycle.",
  "artifacts": [
    {
      "name": "overview.html",
      "path": "explainers/overview.html",
      "source": "thread-storage"
    }
  ],
  "present": [{ "name": "overview.html", "title": "How request handoff works" }]
}
```

Existing records may omit both title and body to attach files or present current
HTML. Reuse needs only `id` and `present`. Capturing HTML alone does not present it.
Titles are single-line plain text, up to 80 characters. Identity is the record ID
and artifact name. Re-presenting updates that thread's title without duplicating
the entry. Separate threads can use different titles for the same saved document.

Save returns the record plus `presented` results with `attached`, a compact
`::explainer` opener reference, and an error on failure. Include the reference
in the reply when presenting. It renders a button, never an inline document.
If metadata attachment fails, saved bytes remain preserved. Clicking the opener
opens the panel, which attaches the reference to its own thread and offers Retry
if attachment fails. In an embedded chat with no Explainers destination, the
button returns to the source thread without writing metadata or opening a raw file.

`present` requires a calling BB thread. An explicit `threadId` selects the source
of artifact bytes and new record text, never the presentation destination.
Attachment-only saves preserve record provenance, scope and body mtime. Pure
presentation writes neither the body nor manifest. New records require title and
body. Full text saves cite the source thread's latest event unless a valid
`sourceSequence` is given. Use `global: true` for cross-project records.

## Storage and reading

Each `records/<id>/` contains `body.md`, `artifacts.json`, and `artifacts/`.
The body has JSON-valued frontmatter followed by Markdown. Edit it directly for
text updates, keeping the frontmatter intact except the title. The agent tool can
also replace its full text. There is no version pointer or edit conflict token.

Files are copied from the source thread's host and confined to its workspace or
thread-storage root. Limits are 16 MiB per artifact, 64 MiB per capture, and
256 KiB of inline metadata. The manifest is authoritative. Replacing a logical
name publishes new checksummed bytes and retains old bytes on disk. Unlisted
files are never rediscovered. A malformed manifest leaves the record's notes
readable and blocks artifact updates until repaired.

Thread plugin metadata stores only references, short titles and the time added.
There is no historical-thread migration or implicit inheritance by forks and
side chats. Agents explicitly present relevant saved files in each thread.
The panel destination is always available and does not open automatically.
Targets are session-only, so a page reload starts at the list.

The reader accepts current HTML up to 5 MiB, verifies its hash and UTF-8 encoding,
and renders it in a sandbox without same-origin access. Scripts and external-link
popups work. BB theme variables and color scheme are injected. Theme changes may
reload a document. Other refreshes keep the frame intact when its hash is unchanged.
Use self-contained HTML with inline CSS, JavaScript and assets. Companion files are
not served by the reader. Saving is preservation, not filesystem write protection.

## Search and maintenance

QMD indexes `body.md` directly, using isolated config and cache under `.qmd/`.
Artifact contents are not indexed. Describe what each explainer shows in its
record body. Search defaults to the current project plus global records. Agents
can reuse explainers from other projects through explicit recall.

Opening the library lists records without waiting for QMD. Indexes refresh before
search when records change. Hybrid search also refreshes embeddings and may
download local models. Keyword search needs no model downloads. Failures surface
without a fallback search engine. `bb knowledge sync [--embed]` forces a refresh.
`bb knowledge delete <id>` moves the record into recoverable library trash.

The optional [benchmark runner](scripts/benchmark.mjs) preserves experiment
context, logs and metrics. Read its `--help` before use.

For development, run `npm test`, `npm run typecheck`, and `npm run build`.
