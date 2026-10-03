---
name: retitle
description: Check or refresh a bb thread's title with the Retitle plugin's `bb retitle check` command. Use when the user asks why a thread was renamed, wants a title refreshed, or wants automatic renaming re-enabled after a manual rename.
---

# Retitle

The Retitle plugin rechecks a thread's title after each human message, once the turn settles. It renames the thread when the topic has drifted, the title omits the main module, or the title is cut off. Agent-initiated turns never trigger it.

## Commands

| Command | Effect |
| --- | --- |
| `bb retitle check [thread-id]` | Dry run. Prints `Would rename`, `Kept`, or `Skipped: <reason>`. Defaults to the current thread. |
| `bb retitle check [thread-id] --apply` | Writes the proposed title and clears a manual-rename lock. |
| `bb retitle check [thread-id] --json` | Prints the outcome as JSON, with cost and duration. |
| `bb plugin logs retitle` | Shows one line per automatic check. |

## Skip reasons

- `locked`: the user renamed the thread by hand, so automatic renaming is off for that thread. Run `--apply` only if the user asks to re-enable it.
- `renamed-by-user`: the plugin just detected a manual rename and locked the thread.
- `handoff`: an untitled `Continue from @thread:…` thread. It shows the source thread's live title, so it is never retitled.
- `archived`, `hidden`, `empty`: nothing to title.
- `changed-during-check`: the title changed while the model ran, so the result was dropped.

## Settings

`bb plugin config retitle set model <alias-or-id>` picks the Claude model. The default is `sonnet`. `haiku` costs about 4× less but decides less consistently.
