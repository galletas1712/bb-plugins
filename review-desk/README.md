# Review Desk

Review GitHub pull requests inside bb with their original description, conversation, and diffs.

- Open a PR URL, `owner/repo#123`, or `owner/repo/stack/N`.
- Your authenticated GitHub account's open PRs appear automatically across all repositories, including drafts. Discovery checks every 15 seconds. Closed and merged PRs are hidden throughout Reviews and stack navigation. Stacks with no open PRs are hidden. Explicitly removed PRs stay hidden until you open them again.
- Open PRs are prefetched in the background every minute with two workers. Prefetch prepares the repository, changed-file list, metadata, comments, conversation, merge action, description permissions, file patches, and Markdown content. Cached PRs open immediately while refreshing. A first visit can still wait if its Git preparation has not finished. Foreground and background requests share preparation, and unchanged refs reuse the Git and file caches.
- PR pages, conversations, merge actions, file previews, and commits retain cached data across navigation. The repository grid also prefetches saved PR pages. Refreshes update the existing content without clearing it, including when a request fails. The initial PR response includes cached merge options, conversation, description permissions, and the selected patch to avoid sequential loading. The shared UI cache uses TanStack Query and retains inactive queries for 30 minutes. The SQLite read cache survives plugin reloads and is limited to 64 MiB, 2048 entries, and 4 MiB per entry. Patch and file keys include exact revisions. Merge confirmation always reads fresh GitHub options and submission rechecks the action.
- A separate status scan runs every 15 seconds, including closed tracked PRs that can be reopened. It batches up to 50 PRs per GitHub request and updates visibility without waiting for Git fetches or conversation loading. Saved notes and drafts survive closing and reopening. Inaccessible PRs keep their last known state while other PRs continue updating.
- The front page groups PRs by repository, ordered by the latest GitHub PR activity. Repositories have independent dropdowns with standalone PRs and collapsed stacks underneath. Phones show one column with space between repositories. Wider panels show a grid. Expanding a stack shows its PRs in order, with a single removal control for the stack.
- Read the full conversation: issue comments, reviews, inline threads and replies, and timeline events. GitHub collections are paginated, including commits, checks, labels, assignees, and review requests.
- Browse changed files in unified or side-by-side diff mode. Toggle the file explorer to choose files. Moved or renamed files appear at both their old and new locations. Deleted and old locations use a red D, and added and new locations use a green U. Current comments appear on their old/new diff lines. File comments, outdated threads, and comments outside the displayed hunks remain visible above the file. Threads on files no longer in the PR remain in Conversation.
- Resolved and outdated threads sit inside collapsed dropdowns in each file diff and in Conversation. Open a dropdown, then expand individual threads as needed. Comments with text have their own show/hide control, with replies beneath their original comment. Reviews without a visible message appear as compact activity rows such as approvals or requested changes, without empty comment boxes.
- A compact PR header keeps the repository/number, title, status and review/merge actions together. Navigation and branch details share the second row. Display preferences live in the PR overflow menu. A single file toolbar holds the explorer toggle, path, totals and Markdown view icons.
- Markdown offers Source, Rendered, and Source + Rendered views. The combined view has a resizable divider with saved widths and automatically links scrolling through source-line and rendered-block positions. Source lines remain selectable for comments, and rendered blocks link to their old or new source ranges. Narrow panels show one pane and restore the preferred combined view when widened. Rendered changes use red and green highlights without label rows. Source diffs retain line numbers and colors without plus/minus gutter markers. Repository files remain read-only.
- Edit PR descriptions when your GitHub account has permission. Published comments, review summaries, and inline replies can only be edited by their author. Save checks the latest text and keeps your draft if the request fails.
- Reply to or resolve GitHub threads. Select lines to draft a comment, then submit the pending comments together as a review. Approval can be submitted without a message; requesting changes requires a review body.
- Merge using methods permitted by both the repository and the target branch's active rules. The button uses GitHub's preferred method for your account in the repository when permitted, otherwise the first allowed method. Multiple methods share one split button with a dropdown. A single permitted method needs no selector. The button names the selected action, such as Squash and merge. Confirmation shows the target branch and every affected open PR, including downstack PRs for native GitHub stacks. Fresh checks reject changed heads, stack scope, permissions, or disallowed methods. GitHub processes merges asynchronously with repository rules enforced. Pending and failed requests remain visible until GitHub reports success. Merge queues and automatic merging are not enabled by this control.
- Keep a comment private as a note, or add it to your pending review later. Stale comments remain visible and can be deleted.
- Open individual commits or shift-click a second commit for a range. Commit diffs link back to the PR head for commenting.
- Toggle the file explorer and PR stack sidebars independently. They default to hidden on small screens, but an explicit open or closed choice is remembered across screen sizes and PRs. Selecting a file keeps an explicitly opened explorer open. `[` / `]` moves between stack layers; other layers open when selected.
- PR summaries show added and deleted line totals. Stack summaries sum the totals of their PRs. Rename-aware Git counts exclude pure file moves while preserving edits made in renamed files.
- PR status uses one icon everywhere: green for open or approved, and gray for draft. Approval uses a checkmark.
- Repository groups show open layers in a tracked stack, including unopened PRs. Stack positions, counts, and totals include only visible layers. Remove the full stack with its single trash control. Membership, totals, titles, and statuses are checked every 15 seconds independently of heavier review requests, even after the original PR leaves the stack. Hidden and detached PRs keep their local notes and pending comments. Tracking is retained so a new open layer can bring a hidden stack back.

Changes, Conversation, and Commits use a single main workspace, one view at a time. Submit review opens a dialog with pending comments and review controls, with checks and metadata in expandable sections. Reviews and tracked stacks refresh from GitHub in the background. Visible panels also poll every 15 seconds and refresh on focus or reconnect. Head and base-branch pushes refresh cached diffs. Manual refresh fetches Git again. Fetch errors are shown with a retry action.

Requires an authenticated `gh` CLI on the machine holding the repository. Review Desk finds a local checkout or clones one, then creates a detached worktree for reading the diff.

Review Desk currently uses polling rather than GitHub webhooks. Webhook delivery requires a reachable receiver and repository, organization, or GitHub App configuration. Repository work is serialized so background fetches do not compete over shared Git refs. The plugin never runs global worktree pruning on shared repositories.

## Develop

```
npm install
npm run typecheck
npm test
npm run build
bb plugin install .
bb plugin reload review-desk
```

Tests use Node's built-in test runner with tsx. Focused regressions cover pagination, GitHub comment coordinates, diff annotations, rendered Markdown, editing GitHub text, status displays, and persistent stack synchronization and removal.

## CLI

```
bb review-desk open <url | owner/repo#N | owner/repo/stack/N>
bb review-desk list
bb review-desk stack <reviewId>
```

## Source

- `app.tsx`: conversation, diff, and review submission UI.
- `server.ts`: SQLite storage, caching, pending comments, private notes, RPC and CLI.
- `host.ts`, `host-contract.ts`: repository operations and GitHub RPC contracts.
- `github-conversation.ts`: paginated GitHub history and metadata.
- `stack-fetch.ts`, `stack-store.ts`: stack discovery, persistent tracking, and branch-based fallback.
- `components/pr-status.tsx`: shared status icons and labels.
- `components/merge-pr.tsx`, `lib/github-merge.ts`, `merge-contract.ts`: merge confirmation, GitHub policy and scope checks, and asynchronous results.
- `diff-lines.ts`, `diff-annotations.ts`: valid comment locations and visible annotation placement.
- `components/editable-body.tsx`, `lib/github-edit.ts`: shared text editor and GitHub permission, conflict, and scope checks.
- `components/markdown-diff.tsx`, `lib/markdown-diff.ts`: rendered Markdown block comparisons.
- `components/diff-viewer.tsx`, `lib/scroll-map.ts`: Pierre CodeView, resizable source/preview panes, source-range navigation and synchronized scrolling.

Historical migrations and stored data are retained. Earlier AI-generated reports and notes remain in the database but are no longer shown or regenerated. Manual notes and pending comments remain available.
