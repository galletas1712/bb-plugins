# Workspaces

Runs each thread in its own folder of git worktrees, one per repo you pick from the project. The folder itself is not a git repo, so bb's built-in git banner, Commit button, and Diff tab stay out of the way. It is meant to replace both Project checkout and Worktree.

## What you get

- A "Workspace" environment choice with a repo picker in the new-thread composer. Each picked repo takes an optional start point: a branch, `remote/branch`, tag, commit, or `#pr`. Each project remembers its last initial selection and start points. Picking no repo gives an empty workspace.
- Every repo gets a new branch `<you>/<thread-slug>`, so a workspace never shares a checkout with anything else.
- `bb workspaces add <repo>[@<start>]` adds more repos mid-session. Agents can run it themselves.
- A **Changes** panel tab lists each repo's uncommitted changes or branch commits, with diffs. It also works in threads that use other environments.
- The plugin never commits or pushes. When the workspace is removed, its folders go away with any uncommitted work, like bb's own Worktree provider. Branches stay, and unarchiving brings the workspace back on them.

## Good to know

Works for projects whose folder is one repo or holds several repos side by side. Submodules and LFS files are left for each repo's own setup.
