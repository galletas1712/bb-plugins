# bb-plugin-review-desk

Review GitHub pull requests inside bb: a document-style PR page with the diff, the conversation, inline comment authoring, and a chat with an analyst that has the code in front of it.

## What it does

- **Open a PR** by URL or `owner/repo#123`, or a GitHub stack with `owner/repo/stack/N`. The host entry finds the local checkout among your bb projects (or clones it), fetches the PR head, and keeps a detached worktree under the plugin's host data directory. If the PR is in a `gh stack`, every layer is opened as its own review (worktree, diff, comments). A stack rail lists every layer from the trunk up; `[` and `]` move between them. Comments, approval, and the reviewable diff stay on the current PR. Files that also change in other layers show those PRs next to a stack icon. Open reviews keep the PR, its comments, and the stack in sync with GitHub in the background. Closed or merged PRs leave Recent; if GitHub reopens them, the same review comes back with its chats, notes, and pending comments. Trash removes a review for good without closing it on GitHub.
- **PR page**: state, title, author, base and head branches, then Brief, Description, Discussion (reviews, comments, open threads), and Commits. **Mark ready** / **Mark draft** next to the state pill writes that to GitHub (`gh pr ready`). The **Diff** tab in the right pane is the file viewer: a hideable directory tree and one file at a time, with viewed marks as you go.
- **Diff** per file with Pierre diffs: unified or split, syntax highlighting from bb's code theme, expandable context, line selection. Jumping from Brief, Discussion, Info, or Codemap opens that file and line in the Diff tab.
- **Brief** tab, first and default: a **slop** score (0 to 100) from deterministic signals over the diff (AI phrasing, comments that repeat the code, defensive noise, weakened or skipped tests, stubs, commented-out code, duplicated blocks, modules outside the stated scope, description shape, over-commenting, semicolons and dash punctuation in comments and the PR body), each with the lines it came from; plus a **plain-English brief** written by a hidden helper thread from the diff itself: what the PR does, changes by area, every description claim checked against the code, and a second score from the helper with evidence lines. Every cited line opens the diff. Signals recompute when the head is new; the helper runs once when `autoBrief` is on. Refresh on Slop recalculates both (not on the 15s GitHub poll). The refresh control turns red when the helper's result is for an older head.
- **Commits you can open**: click a commit in the Commits tab for its diff against its first parent (position, Older and Newer, full message, GitHub link); shift-click a second commit to diff the range between them. The review remembers the head you last opened it at, marks newer commits "new" with a divider at your last position, and offers "Diff the N new commits since you last looked". Commit views are read-only apart from the chat: select lines to ask about them as they were at that commit (a pill pinned to the sha), `@` a commit by sha or title, and use Comment at head to jump to the same lines in the PR diff.
- **GitHub threads inline**, anchored to their lines, with reply and resolve. Comment cards use the app font, wrap, render `<details>` as collapsibles, and carry chips for the PR author, bots, severity, and finding ids.
- **Comments**: select lines and press Comment, or use the gutter button. Comments stay pending until you submit one review from the Info tab as comment, approve, or request changes. Nothing reaches GitHub without that click. After a push, comments whose path or line left the diff are marked stale: they stay visible at the top of the file (or in Info if the file is gone), with Delete and Remove stale. Submit posts the rest and drops the stale ones.
- **Private notes**: comments only you see, shown inline with an amber dashed edge. Three sources: any slop signal can be shown as notes on its lines from the Brief tab; **Find slop and cleanups** (Notes menu in the Diff tab) has the helper read the diff and leave up to 25 notes with kind (slop, cleanup, risk, question), severity, and sometimes a suggested rewrite; and **Keep private** on the comment composer. Each note can be dismissed, promoted to a pending GitHub comment (a suggestion becomes a `suggestion` block), sent to the chat as a pill, or sent to the council. Notes carry a content hash of their line and follow it across pushes; ones whose line is gone are marked stale.
- **Chat with the PR**: the Chat tab hosts one analyst thread per provider, spawned into the PR worktree and read-only by instruction, rendered with bb's own thread view. The first message comes from bb's new-thread composer (pick provider and model there; the environment shown is ignored, the analyst always runs in the PR worktree); later messages go through the thread's own composer. Message actions turn an answer into a pending comment on the selected lines or send it to a Roundtable room.
- **Code pills**: code goes into the chat as @-mention pills that resolve to text when you send, so the transcript stays short and the analyst gets the excerpt. Three ways in: select lines in the diff and press `a` or **Add to chat**; type `@` in the composer to search changed files, changed symbols from the codemap, GitHub review threads, the PR description, or an explicit `path:10-20`; or pick **Summarize in chat** on a file card. A banner above the composer shows the current diff selection with its own **Add to chat**.
- **Codemap**: tree-sitter (Rust, Python, TypeScript, JavaScript, Go, C and C++) diffs symbols across base and head, links references between changed symbols, counts fan-in with `git grep`, orders modules for reading, and ranks hotspots. Regex extraction is the fallback.
- **Info** tab: checks with a progress bar, reviewers with their state, assignees, labels, the pending review, and ready/draft.

## Layout

- `host-contract.ts` — RPC contract between server and host.
- `host.ts` — runs on the machine with the repository: git worktrees and diffs, `gh` for PR data and review submission, tree-sitter codemap.
- `stack-fetch.ts` — GitHub stack discovery (`gh stack` GraphQL/REST, then a base/head walk when the Stack API is off).
- `server.ts` — SQLite store (reviews, viewed files, GitHub caches, pending comments, chat seats, codemaps, stacks), RPC for the UI, `bb review-desk` CLI.
- `prompts/` — Jinja templates for analyst and helper model prompts; `prompts.ts` renders them.
- `app.tsx` — the **Reviews** nav panel; fixed tabs **Diff**, **Info**, **Chat**, **Codemap**; the composer banner that receives pills.
- `slop.ts` — deterministic slop signals over parsed patches (pure functions, server-side).
- `brief-spec.ts` — the brief the helper thread returns, shared by server and app.
- `mention-ref.ts` — pill identity shared by server and app (what a pill points at, how its id is encoded, its label).
- `skills/review-desk/SKILL.md` — static instructions the analyst threads receive (not interpolated).

## Develop

```
npm install
bb plugin install .      # builds server, app, and host bundles and registers the directory
bb plugin reload review-desk
npx tsc -p .
bb plugin logs review-desk
```

Requires `gh` authenticated on the machine that holds the repository.

## CLI

```
bb review-desk open <url | owner/repo#N | owner/repo/stack/N>
bb review-desk list
bb review-desk ask <reviewId> <text...> [--provider <id>]
bb review-desk codemap <reviewId>
bb review-desk stack <reviewId>
```

## Settings

- `defaultProvider` (default `claude-code`): the analyst preselected in Chat and used by the CLI.
- `hideSeatThreads` (default true): keep analyst and helper threads out of the sidebar.
- `autoBrief` (default true): write the plain-English brief the first time a review is viewed at a new head.
- `helperProvider` (default `pi`) and `helperModel` (default `nvidia-inference/nvidia/zai-org/glm-5.3`, Pi GLM 5.3): provider and model for the helper thread that writes the brief, the model slop score, and notes. Change the model from the Slop card.
