# Workspaces

An environment provider that runs each thread in its own folder of git worktrees. You pick which of the project's repos the thread gets and where each starts, and the agent can add more later. It is meant to replace bb's Project checkout and Worktree providers for every project, single-repo or multi-repo. The folder itself is not a git repo, so bb shows none of its built-in git UI (status banner, Commit button, Diff tab) for these threads. A **Changes** panel tab shows what changed in each repo instead.

```
~/.bb/plugins/workspaces/host-data/workspaces/<thread>-<attempt>/   ← the thread's working directory
├── AGENTS.md    generated: the repo list and rules for the agent
├── CLAUDE.md    @AGENTS.md
├── dynamo/      worktree of ~/dynamo/dynamo    on <user>/<slug>
└── snapshot/    worktree of ~/dynamo/snapshot  on <user>/<slug>
```

A project whose folder is a single repo gets the same layout with one child.

## How it works

| Concern | Behavior |
| --- | --- |
| Which repos are offered | A project folder that is itself a repo offers that repo. Otherwise every direct child that owns a `.git` directory and has a remote. Linked worktrees, repos without a remote, and folders whose names are hidden or not `[A-Za-z0-9._-]` are skipped. |
| Picking | The new-thread composer shows repository checkboxes below its project and environment controls. Each checked repo has an optional start field. After a workspace is created, its initial selection and start points become the default for that project, including an intentionally empty selection. For projects with no saved default, the picker uses the initial selection of their latest existing completed workspace, if any. Only repos available on the chosen machine are selected. A single-repo project is picked for you. Picking none in a multi-repo project gives an empty workspace that repos can be added to later. |
| Start point | Empty means a fresh fetch of the live default branch of the repo's `upstream` remote, or `origin`, or its first remote. The branch name comes from `git ls-remote --symref`, because a clone's recorded `origin/HEAD` goes stale. Otherwise one of: `#<n>` or `<remote>#<n>` (a pull request head, from the base remote by default), `<remote>/<branch>` (fetched fresh), or a local branch, tag, or commit, else a branch, tag, or full commit id fetched from the base remote. If any fetch fails, nothing is created. |
| Branch | Always a new branch `<user>/<slug>`, the same name in every repo, where `<user>` is the machine's user name and `<slug>` is bb's suggested branch without its `bb/` prefix and thread id. A `-2`, `-3`, ... suffix keeps it unused locally and on every remote in every repo the project offers. Because the branch is always new, a start branch that is checked out elsewhere, such as in the main clone, is never a conflict. Created with `--no-track`, so a plain `git push` cannot target the start branch. If create runs again after a restart, it keeps the branch name it started with. |
| Start commit | When the start was chosen, its commit is kept in `branch.<branch>.workspacesStart` in the repo's config, which git deletes with the branch. The Changes panel compares against it. |
| Commits and pushes | Never made by the plugin. The agent commits and pushes, to whichever remote the repo's work goes to. |
| Adding repos later | `bb workspaces add <repo>[@<start>]...`. The agent runs it from its shell. From a terminal, pass `--thread <id>`. A repo already in the workspace keeps its start. A slow fetch keeps going if the caller gives up, so running the command again finds the repo added. |
| Removal | After bb retires the environment, processes in the folder are stopped and each worktree is deleted with its uncommitted work, the same as bb's own Worktree provider. Branches are never deleted. Anything outside the repo folders is deleted too. |
| Restore | Unarchiving a thread whose workspace was removed recreates the same repos, including ones added mid-session. Each uses its kept branch, or a pushed copy if the branch was deleted locally. This needs no fetch. |
| Repo hooks | Not run for the plugin's own fetches and worktree adds. The agent's own git commands run them as usual. |
| Other worktrees | The plugin never runs `git worktree prune`. That command deletes every `.git/worktrees` entry git judges gone, including live worktrees of bb's own Worktree provider and other tools, and the next `worktree add` then hands their entry to someone else. The plugin only deletes entries for its own folders. |

The repo list and each repo's start for each workspace live in the plugin's kv store under `workspace:<pathKey>`, because bb's environment inputs are fixed at creation and restore runs after the folder is gone. Entries are kept even after a thread is deleted, because forks can share its environment.

## Changes panel

Open it from the right panel's new-tab menu (**Changes**) in any thread. It works in Workspace threads, in threads whose folder is a repo, and in a plain folder of repos such as `~/dynamo`, where it also looks one folder down (`worktrees/<name>`).

| Concern | Behavior |
| --- | --- |
| Uncommitted | `git status` per repo against HEAD, including files inside new folders, staged renames, and conflicts. |
| Branch | What the branch's commits changed since its recorded start commit, when it has one. Otherwise since it left `<remote>/HEAD`, the base remote's default branch. Workspaces refresh that record on every fetch. In other clones it is whatever `git clone` or `git remote set-head` last wrote. |
| Layout | Repos with changes get a section, collapsed when they list more than 25 files. Clean repos share one line. A repo that fails shows its own error. |
| Diffs | Click a file to see its patch in bb's diff viewer (Pierre), with each side of a rewritten rename shown. Patches over 512 KiB are not shown. |
| Refresh | Scans while the tab is on screen, again after 3 s or four times the last scan's duration, whichever is longer. A folder of ~90 repos takes about 8 s, so it refreshes about every half minute. Lists stop at 500 files per repo. |

## Limits

- Submodules are not initialized and LFS files stay pointers. Run each repo's own setup if it needs them.
- Repos' own `.bb-env-setup.sh` scripts do not run.
- Under bb's sandboxed permission modes (Accept edits, Auto), commits inside the repos need approval. bb only allows writes to git metadata outside the folder when the folder itself is a repo.
- The workspace folder must not be inside another git repo, such as a dotfiles repo in your home folder. Creation fails with a message if it is.
- If a repo is moved while a workspace still uses it, removal fails until the repo is back, so the repo's record of the worktree is cleaned up with it. `bb environment show <id>` shows the message.
- bb's thread header shows no branch or pull request for a Workspace thread, because its folder is not a repo. The Changes panel and the agent's `gh` are the way to see them.
- Files of a project that are not in any repo, such as notes or artifacts folders next to the repos, are not copied into the workspace. The agent reaches them through the project path listed in `AGENTS.md`.

## Develop

```sh
npm install --include=dev
npm test
npx tsc --noEmit
bb plugin install .
```

`repo-spec.ts` parses `<repo>[@<start>]`. `workspace.ts` names branches, resolves start points, and creates and removes workspaces and `changes.ts` reads changes. Both run on the machine through `host.ts`, and `git.ts` runs git for them. `server.ts` registers the environment provider, the RPCs, and the CLI, and keeps each workspace's repo list. `repo-picker.tsx` and `changes-panel.tsx` are the UI, registered in `app.tsx`. `workspace.test.ts` and `changes.test.ts` run against real repos in a temp folder, and `server.test.ts` drives the provider, RPCs, and CLI through bb's fake plugin host.
