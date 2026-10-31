---
name: workspaces
description: Work in or extend a Workspaces environment, where the thread's folder holds one git worktree per repo and is not itself a repo. Use when the working directory has a generated AGENTS.md listing repo folders, when git reports "not a git repository" at the top level, or when the task needs another repo from the project.
---

# Workspaces

The thread's working directory is a plain folder. Each subfolder is a git worktree of one repo from the project, all on the thread's own new branch. The folder's `AGENTS.md` lists them and where each branch started.

- Run git inside a repo folder (`git -C <repo> ...` or `cd <repo>`). At the top level git reports "not a git repository", which is expected.
- Read a repo's own `AGENTS.md` or `CLAUDE.md` before working in it.
- The branch tracks nothing. Committing and pushing are your job. Push to whichever remote and branch the task needs, for example `git push -u <remote> HEAD`, or `git push <remote> HEAD:<their-branch>` to update the branch the repo started from.
- The new-thread picker defaults to the project's most recently created workspace's initial repo selections and start points. Repos added later do not change that default. An empty selection is remembered too.
- When the workspace is removed, its folders are deleted, uncommitted work included. Commit anything worth keeping. Branches and commits stay in the repos.

## Adding a repo

| Command | Effect |
| --- | --- |
| `bb workspaces add <repo...>` | Fetches each repo's upstream default branch and adds a worktree for it on the thread's branch. Repos already present are left alone. |
| `bb workspaces add <repo>@<start>` | The same, starting from `<start>`: a branch, `<remote>/<branch>` (fetched fresh), a tag, a full commit id, `#<pr>`, or `<remote>#<pr>`. |
| `bb workspaces add <repo> --thread <id>` | The same, for another thread or from a terminal. |

An unknown name fails with the list of repos the project offers. The command prints where each repo was added. The generated `AGENTS.md` is updated too, but it is not reread mid-session, so rely on the command's output.
