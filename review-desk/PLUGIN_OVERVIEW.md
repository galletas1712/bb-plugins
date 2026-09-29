Review a GitHub pull request inside bb the way you would online, with a chat partner that has the code in front of it.

## What you get

- A **Brief** first: a plain-English account of what the PR really does, written from the diff by a helper that reads the code, each description claim checked against the code, and a slop score from diff signals plus a model score, with every signal pointing at its lines.
- A **PR page**: state, title, author and branches, then Description, Discussion, and Commits. Mark the PR ready or convert it back to draft without leaving bb. The diff is a right-pane tab with a hideable file tree and one file at a time. Stacked PRs (`gh stack`) open every layer as its own review; comments and the layer diff stay on the current PR.
- **GitHub threads inline** on their lines, with reply and resolve. Checks, reviewers, assignees, and labels live in the Info tab.
- **Commits**: click one for its diff, shift-click two for the range, and see what is new since you last looked.
- **Comments from the diff**: select lines, write Markdown, keep them pending, then submit one review to GitHub as comment, approve, or request changes. Stale pending comments (the line left the diff) can be deleted from Info or the file.
- **Private notes**: slop and cleanup notes only you see, from the signals, from the helper reading the diff, or your own. Dismiss them, or promote the ones worth saying into pending comments.
- **Chat with the PR**: an analyst per provider runs in a worktree at the PR head. Ask anything. Code goes in as pills: select lines and press `a`, or type `@` to attach a changed file, symbol, review thread, or `path:10-20`. Pills resolve to the code when you send, so the transcript stays readable. Turn an answer into a pending comment or send it to a Roundtable room.
- **Codemap**: symbols added, removed, and modified per file, references between changed symbols, fan-in from the rest of the repository, a reading order by module, and hotspots.

## How it works

The plugin fetches the PR head into a detached worktree on the machine that holds the repository and reads diffs and file contents from git. GitHub data comes from your `gh` login. Stacked PRs are read from GitHub's Stack API (`gh stack`); each layer stays a separate review, and opening any layer opens the rest. Open reviews poll GitHub so the head, description, comments, and stack stay current. Closed and merged PRs leave the list and return with their chats if GitHub reopens them. The chat runs on ordinary bb threads spawned into that worktree, read-only by instruction, rendered with bb's own thread view. The codemap is built with tree-sitter.

## For agents

The bundled skill tells analyst threads how requests arrive and how to answer. Interpolated model prompts (analyst intro, helper jobs, pill context) are Jinja templates in `prompts/`.
