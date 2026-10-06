# Review Desk

Review GitHub pull requests inside bb with their original description, conversation, and diffs.

- Open a PR URL, `owner/repo#123`, or `owner/repo/stack/N`.
- Read the full conversation: issue comments, reviews, inline threads and replies, and timeline events. GitHub collections are paginated, including commits, checks, labels, assignees, and review requests.
- Browse changed files in unified or side-by-side diff mode. Toggle the file explorer to choose files. Moved or renamed files appear at both their old and new locations. Current comments appear on their old/new diff lines. File comments, outdated threads, and comments outside the displayed hunks remain visible above the file. Threads on files no longer in the PR remain in Conversation.
- Resolved and outdated threads sit inside collapsed dropdowns in each file diff and in Conversation. Open a dropdown, then expand individual threads as needed. Every comment and reply has its own show/hide control, with replies beneath their original comment. Review decisions without a message are labeled explicitly.
- Markdown offers Source and Rendered diffs, with added and removed blocks and links to their source lines. Repository files remain read-only.
- Edit PR descriptions when your GitHub account has permission. Published comments, review summaries, and inline replies can only be edited by their author. Save checks the latest text and keeps your draft if the request fails.
- Reply to or resolve GitHub threads. Select lines to draft a comment, then submit the pending comments together as a review. Approval can be submitted without a message; requesting changes requires a review body.
- Keep a comment private as a note, or add it to your pending review later. Stale comments remain visible and can be deleted.
- Open individual commits or shift-click a second commit for a range. Commit diffs link back to the PR head for commenting.
- Toggle the file explorer and PR stack sidebars independently. They default to hidden on small screens, but an explicit open or closed choice is remembered across screen sizes and PRs. Selecting a file keeps an explicitly opened explorer open. `[` / `]` moves between stack layers; other layers open when selected.
- PR summaries show added and deleted line totals. Stack summaries sum the totals of their PRs. Rename-aware Git counts exclude pure file moves while preserving edits made in renamed files.
- PR status uses one icon everywhere: green for open or approved, gray for draft, purple for merged, and red for closed. Approval uses a checkmark.
- Recent shows every layer in a tracked stack, including unopened and merged PRs. Remove the full stack with its single trash control. Membership, titles, and statuses refresh automatically about once a minute, even after the original PR leaves the stack. Detached PRs keep their local notes and pending comments.

Changes, Conversation, and Commits use a single main workspace, one view at a time. Submit review opens a dialog with pending comments and review controls, with checks and metadata in expandable sections. Reviews and tracked stacks refresh from GitHub in the background. Fetch errors are shown with a retry action.

Requires an authenticated `gh` CLI on the machine holding the repository. Review Desk finds a local checkout or clones one, then creates a detached worktree for reading the diff.

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
- `diff-lines.ts`, `diff-annotations.ts`: valid comment locations and visible annotation placement.
- `components/editable-body.tsx`, `lib/github-edit.ts`: shared text editor and GitHub permission, conflict, and scope checks.
- `components/markdown-diff.tsx`, `lib/markdown-diff.ts`: rendered Markdown block comparisons.

Historical migrations and stored data are retained. Earlier AI-generated reports and notes remain in the database but are no longer shown or regenerated. Manual notes and pending comments remain available.
