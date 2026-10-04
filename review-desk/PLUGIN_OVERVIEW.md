# Review Desk

A GitHub pull request review page with the original conversation and inline comments.

- Conversation shows the PR description, comments, reviews, review threads, and timeline events.
- Changes, Conversation, and Commits use a single main workspace, one view at a time. Changes offers unified or side-by-side source diffs, rendered Markdown comparisons, and inline comments. The file dropdown appears only when the file tree is hidden.
- Outdated threads share a collapsed dropdown, with each thread expanded manually. Resolved threads start collapsed. PR descriptions and published comments or replies can be edited with GitHub permissions. Repository files are read-only.
- Submit review opens a dialog to send pending comments with a comment, approval, or request for changes. Private notes stay local until added to a review.
- GitHub history is fully paginated. File-level and outdated comments remain visible when they cannot be placed on a current diff line. Refresh failures are surfaced and retried.
- Commit navigation and PR stacks retain their individual diffs and comments. A left sidebar selects stack layers on wide layouts; a compact dropdown replaces it on narrow layouts. Layers open on demand.

The host worker uses authenticated `gh` and git on the repository's machine. The server caches GitHub data and stores review state in SQLite. The frontend uses BB navigation and Pierre diffs. Existing migrations and user-authored data are preserved.
