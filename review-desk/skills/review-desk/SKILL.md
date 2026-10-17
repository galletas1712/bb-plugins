---
name: review-desk
description: Open or inspect pull requests and PR stacks in the GitHub plugin with the bb review-desk CLI.
---

# GitHub

The GitHub plugin displays pull-request diffs, descriptions, conversations and inline threads. It keeps comments pending until the reviewer submits them to GitHub. Private notes stay in the plugin until added to the pending review. Its stable plugin ID and CLI command are `review-desk`.

Use these commands when the user asks to open or inspect a review:

```
bb review-desk open <url | owner/repo#N | owner/repo/stack/N>
bb review-desk list [--json]
bb review-desk stack <reviewId> [--json]
```

The repository host needs an authenticated `gh` CLI. Opening a PR creates a detached worktree for its diff. Stack navigation lists open layers; other open layers load when selected. Comments and review submission belong to the selected PR.

The GitHub page automatically lists the authenticated account's authored open PRs and open PRs personally requested for review across repositories, including drafts. Team-only review requests do not add PRs. Authored and personally requested discovery and stack membership poll every minute. Discovered PRs share the persistent cache, background prefetch and status scans. Stack checkmarks mean every open layer is ready according to GitHub's merge status, including required reviews, drafts, conflicts and blocking checks. Unknown readiness keeps the normal open/draft icon. Readiness shares the existing 15-second status scan and persists across reloads. Closed and merged PRs are hidden from the front page and stack navigation, and stacks with no open layers are hidden. Counts, positions, and totals include only open layers. Completed PRs and stacks cannot be opened. Hidden PRs retain saved drafts and notes. Explicitly removed PRs stay hidden until reopened.

Open PR diffs are prefetched every minute with two workers. Active PR details refresh every minute, and inactive full details use a ten-minute safety sweep or detected changes. Cached opens return immediately while refreshing, and repeated requests share preparation. Independent batched status scans every 15 seconds automatically fetch changed head/base revisions, watch tracked closed PRs for reopening and hide completed PRs without waiting for heavy fetches. The plugin uses polling and does not configure GitHub webhooks.

The UI supports replying to and resolving GitHub review threads, writing pending inline comments, and submitting a comment, approval or request for changes. Removing a review from the plugin does not close it on GitHub.

The merge button names the selected allowed method, such as Squash and merge. Confirmation lists the destination branch and affected PRs. Native GitHub stack merges include open downstack PRs. Fresh GitHub checks validate permissions, methods, head and stack scope before submitting an asynchronous direct merge with repository rules enforced. The UI tracks pending, failed and successful outcomes. It does not enable automatic merging or bypass merge queues. Review summaries without visible text appear as compact activity rows instead of empty comments.

The compact PR header keeps a single repository breadcrumb, title, status and review/merge actions, with navigation and branches on the second row. Display options live in the overflow menu. Markdown's file toolbar has Source, Rendered, and Source + Rendered icon views. The combined view uses a saved resizable divider and automatically synchronizes source lines with rendered blocks. Comments stay on source lines, with old/new-side coordinates preserved. Rendered hunks use green/red highlights without label rows, and source diffs omit plus/minus gutter markers. Narrow panels use a single pane and restore the wider view preference on resize. Repository files remain read-only. Resolved and outdated threads share collapsed dropdowns in each file diff and in Conversation, with each thread expanded manually. Each thread has one show/hide control and one author/time/action header, with replies underneath and no nested comment toggles. Standalone conversation comments have one disclosure with Edit in the header. The UI can edit PR descriptions when permitted by GitHub, and published comments, review summaries, or inline replies only when authored by the authenticated user.
