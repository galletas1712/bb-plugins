# Retitle

Keeps thread titles in step with the conversation. bb names a thread once, from its first prompt. After that, this plugin rechecks the title each time you send a message.

## What you get

- After each of your messages, once the agent finishes, a Claude model reads the conversation and renames the thread if its topic has moved on.
- Titles name the module or plugin the work is about.
- Renaming a thread yourself stops automatic renaming for that thread.
- `bb retitle check <thread>` shows what the model would do, without changing anything.

## How it works

The plugin reads bb's message previews for the thread and asks Claude Sonnet, through the local `claude` CLI, whether the title still fits. It uses your existing Claude login. A check costs about half a cent to a cent at list price. Agent-initiated turns and tool calls never trigger a check.
