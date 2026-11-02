# Roundtable

A shared conversation with agents from different providers. Choose participants, ask for replies, or let them discuss together for a bounded number of turns.

- Each participant has an ordinary bb thread in the room's workspace.
- Select names or type `@handle` to address participants. **Ask for replies** gets one reply from each selected participant, in parallel.
- **Discuss together** schedules a conversation between at least two participants. It ends at the turn limit or when everyone agrees; requests for input pause it until you respond.
- Participant menus contain thread access, file-edit permission, compaction, restart, and removal. New and restarted participants receive the room history.
- Optionally pin a working document and assign its owner in room settings. The link opens in bb's file viewer. Only the owner edits that document; other workspace edits require permission.

## Develop

```
npm install
npx tsc -p .
bb plugin build .
bb plugin install .
bb plugin dev
```

`server.ts` owns SQLite storage, delivery, bounded discussions, RPC, and CLI commands. `app.tsx` provides the room UI and participant thread tab. Agent instructions live in `skills/roundtable/SKILL.md`.

Database migrations are append-only. Existing room history survives updates.

## CLI

```
bb roundtable list
bb roundtable show <room> [--since <seq>]
bb roundtable create --title <title> [--project <id>] [--participants claude=claude-code,codex=codex] [--doc <path> --owner <handle>] [--turns N]
bb roundtable say <room> [--to a,b] [--turns N] [--as <handle>] <message...>
bb roundtable discuss <room> --between a,b [--turns N] <message...>
bb roundtable add <room> <handle>=<provider>[=model][:edit]
bb roundtable doc <room> --path <path> [--owner <handle>]
bb roundtable intro <room> <handle>
bb roundtable compact|reset|remove <room> <handle>
bb roundtable resume|cancel|stop|archive <room>
```

A room can be addressed by its id or exact title. Inside a participant thread, `say` posts as that participant. For CLI messages, `--turns` allows bounded relays to other agents; `--turns 0` requests direct replies only. On `discuss`, it sets the discussion's total turn limit. Use `--json` for structured output.

The former `--brief` and `--summarizer` flags are removed. Added and restarted participants always receive room history.

## Settings

Participant threads are hidden from the sidebar by default and remain accessible from their room menus. To show them:

```
bb plugin config roundtable set hideParticipantThreads false
bb plugin reload roundtable
```
