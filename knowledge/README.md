# Knowledge

A personal BB library for project context and evidence. Agents recall useful
knowledge, read it, and update matching records or save new material. Records are
portable Markdown and JSON files. QMD provides search.

## Install

Requires BB 0.44+, Plugin SDK 0.5.29+, Node 22+, and QMD 2.8.3+ on the BB server.
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

## Use

The [knowledge-library skill](skills/knowledge-library/SKILL.md) guides agents to
recall relevant knowledge and preserve missing context and evidence as they work.
This includes explanations of prior work and routine tasks that become interesting.
Already covered material is reused. A matching record is updated before another
is created. Useful older behavior stays in the current text with its code versions,
conditions, and sources.

Native tools expose `knowledge_recall`, `knowledge_read`, and `knowledge_save`.
Agents can also use the equivalent CLI. Open **Knowledge** to browse, search, and
read records, edit a record with its pencil icon, or save one through the form.
Edits stay in the Knowledge view and retain the source, project, artifacts, and
previous versions, even when the source session no longer exists. Concurrent
changes are rejected rather than overwritten.

```sh
bb knowledge search "worker reconnect" --json
bb knowledge search "why does the worker stall" --engine hybrid --json
bb knowledge read worker-reconnect --json
bb knowledge save --input-stdin < capture.json
```

Save input requires `id`, `expectedVersion`, `title`, and `body`. Use version 0 to
create, or the record's current version to update. `threadId` defaults to the
calling agent's BB thread. `sourceSequence` defaults to its latest event at save
time. Explicit values can cite another thread or an earlier point in its history.
The citation boundary does not imply every event was read. Outside a BB thread,
provide `threadId`. The UI form asks for a source thread.

For `--input-stdin`, `capture.json` must contain a single line of JSON. `global`
and `artifacts` are optional. The personal `AGENTS.md` directs agents to load the
plugin's skill when available.

## Storage and evidence

Records contain a title and Markdown body, with source, project, dates, and optional
artifacts. Put conditions, uncertainty, and measurements in the text. QMD ranks
relevance. Agents reconcile claims from evidence, not edit timestamps alone.

Each `records/<id>/` contains a HEAD pointer, checksummed artifacts, and immutable
version folders with `record.json` and `report.md`. Complete versions publish
atomically. Exact retries are idempotent and conflicting updates fail. All records
can be revised while retaining prior versions. Edit through the plugin, not by
changing published folders. The plugin does not maintain a separate review database.

Files are copied from the source thread's actual host and confined to its workspace
or thread-storage root. Only explicitly listed files are preserved. Limits are
16 MiB per artifact, 64 MiB per capture, and 256 KiB of inline metadata. Larger
assets need a separate durable destination.

Retrievable code can be referenced by repository, commit, and paths. Preserve
uncommitted changes and manifests, inputs, logs, and other evidence needed to
reproduce or interpret experiments. Durable external copies can be referenced.

## Search and maintenance

QMD indexes the latest record text in the rebuildable `search/` Markdown projection,
using isolated config and cache under `.qmd/`. Indexes refresh before search when
records change. Hybrid search also refreshes embeddings as needed and may download
local models. Keyword search needs no model downloads. Calls serialize, time out
after three minutes, and cancel on disposal. Failures are surfaced without a
fallback search engine.

Recall takes up to 200 QMD candidates and filters by project scope, which can omit
lower-ranked matches in large libraries. Default scope is the current BB project
plus global records. Prior revisions and attachment contents are not indexed.
Keep useful historical details and important artifact results in the current body.

`bb knowledge status` shows the library location and record count.
`bb knowledge sync [--embed]` forces a refresh for maintenance. Normal agent work
does not require either command. BB handles thread archiving independently.

## Optional experiment runner

Run [scripts/benchmark.mjs](scripts/benchmark.mjs) with `--help` for usage. It accepts
workload/context JSON, runs a command with `KNOWLEDGE_RUN_DIR`, records elapsed time
and workload-supplied metrics, preserves logs and failed-run evidence, and saves
a record. Compare runs only after checking workload, hardware, units, and method.

For development, use `npm run typecheck` and `npm run build`.
