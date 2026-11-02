# bb-plugins

Plugins for [bb](https://bb.dev), the agentic IDE.

| Plugin | What it does |
| --- | --- |
| [`knowledge/`](knowledge/) | Durable project context and evidence with QMD search and versioned updates. |
| [`live-file-viewer/`](live-file-viewer/) | Preview and edit Markdown, HTML, and SVG files side by side. |
| [`roundtable/`](roundtable/) | Discuss ideas or implementation with several agents in one room, using `@mentions` and bounded rounds. |
| [`retitle/`](retitle/) | Keeps thread titles current. After each user message, Claude Sonnet rereads the conversation and renames the thread when its topic drifts, naming the module the work is about. |
| [`review-desk/`](review-desk/) | Review pull-request diffs and GitHub conversations, draft inline comments, submit reviews, and navigate PR stacks. |
| [`workspaces/`](workspaces/) | An environment provider that runs each thread in a folder of git worktrees, one per repo you pick from the project, each on a new branch from a start point you choose (default branch, branch, tag, commit, or PR). Replaces Project checkout and Worktree. A Changes panel tab shows each repo's changes. Agents add repos mid-session with `bb workspaces add`. |

Each directory is a self-contained plugin with its own `package.json`, README, and `PLUGIN_OVERVIEW.md`.

## Install

```
git clone git@github.com:ishandhanani/bb-plugins.git
cd bb-plugins
bb plugin install ./roundtable
bb plugin install ./review-desk
bb plugin install ./live-file-viewer
bb plugin install ./retitle
bb plugin install ./knowledge
bb plugin install ./workspaces
```

Iterate with `bb plugin reload <id>`; type-check a plugin with `npx tsc -p .` inside its directory.
