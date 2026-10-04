---
name: review-desk
description: Open or inspect GitHub pull requests and PR stacks in Review Desk with the bb review-desk CLI.
---

# Review Desk

Review Desk displays GitHub pull-request diffs, descriptions, conversations and inline threads. It keeps comments pending until the reviewer submits them to GitHub. Private notes stay in Review Desk until added to the pending review.

Use these commands when the user asks to open or inspect a review:

```
bb review-desk open <url | owner/repo#N | owner/repo/stack/N>
bb review-desk list [--json]
bb review-desk stack <reviewId> [--json]
```

The repository host needs an authenticated `gh` CLI. Opening a PR creates a detached worktree for its diff. Stack metadata lists every layer; other layers open when selected. Comments and review submission belong to the selected PR.

The UI supports replying to and resolving GitHub review threads, writing pending inline comments, and submitting a comment, approval or request for changes. Removing a review from Review Desk does not close it on GitHub.

Markdown files offer rendered block comparisons alongside source diffs. Repository files remain read-only. Outdated threads share a collapsed dropdown in each file diff and in Conversation, with each thread expanded manually. Resolved threads start collapsed. The UI can edit PR descriptions, published comments, review summaries, and inline replies when permitted by GitHub.
