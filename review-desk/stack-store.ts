import type Database from "better-sqlite3";
import { prStackSchema, type PrStack } from "./host-contract";

export interface TrackedStack {
  key: string;
  owner: string;
  repo: string;
  hostId: string;
  stack: PrStack;
  fetchedAt: number;
  openedAt: number;
}

/** A tracked stack survives its original PR leaving or merging. */
export function createStackStore(db: Database.Database) {
  interface Row { key: string; owner: string; repo: string; host_id: string; json: string; fetched_at: number; opened_at: number }
  // GitHub retains gaps in stack positions after layers leave the stack.
  const ordered = (stack: PrStack): PrStack => ({ ...stack, entries: [...stack.entries].sort((a, b) => a.position - b.position).map((entry, index) => ({ ...entry, position: index + 1 })) });
  const decode = (row: Row): TrackedStack => ({ key: row.key, owner: row.owner, repo: row.repo, hostId: row.host_id, stack: ordered(prStackSchema.parse(JSON.parse(row.json))), fetchedAt: row.fetched_at, openedAt: row.opened_at });
  const byKey = db.prepare<[string], Row>("SELECT * FROM tracked_stacks WHERE key = ?");
  const byPr = db.prepare<[string, string, number], Row>("SELECT * FROM tracked_stacks WHERE owner = ? AND repo = ? AND EXISTS (SELECT 1 FROM json_each(tracked_stacks.json, '$.entries') WHERE json_extract(value, '$.number') = ?)");
  const rows = db.prepare<[], Row>("SELECT * FROM tracked_stacks ORDER BY opened_at DESC");
  const upsert = db.prepare("INSERT INTO tracked_stacks (key, owner, repo, host_id, json, fetched_at, opened_at) VALUES (@key, @owner, @repo, @host_id, @json, @fetched_at, @opened_at) ON CONFLICT(key) DO UPDATE SET host_id = excluded.host_id, json = excluded.json, fetched_at = excluded.fetched_at");
  const drop = db.prepare<[string]>("DELETE FROM tracked_stacks WHERE key = ?");
  const list = (): TrackedStack[] => rows.all().map(decode);
  const forPr = (owner: string, repo: string, number: number) => { const row = byPr.get(owner, repo, number); return row ? decode(row) : undefined; };
  const save = db.transaction((owner: string, repo: string, stack: PrStack, hostId: string, previousKey?: string, fetchedAt = Date.now(), openedAt = fetchedAt) => {
    stack = ordered(stack);
    const overlaps = list().filter((item) => item.owner === owner && item.repo === repo && (item.key === previousKey || item.stack.entries.some((entry) => stack.entries.some((next) => next.number === entry.number))));
    const key = stack.number !== null ? `gh:${owner}/${repo}#${stack.number}` : previousKey ?? overlaps.find((item) => item.stack.number === null)?.key ?? `inf:${owner}/${repo}#${stack.entries[0]?.number ?? 0}`;
    const related = overlaps.filter((item) => item.key === key || item.key === previousKey || item.stack.number === null);
    for (const item of overlaps) {
      if (item.key === key) continue;
      if (related.includes(item)) { drop.run(item.key); continue; }
      // A PR moved to another native stack. Keep tracking the remaining stack.
      const remaining = { ...item.stack, entries: item.stack.entries.filter((entry) => !stack.entries.some((next) => next.number === entry.number)) };
      upsert.run({ key: item.key, owner, repo, host_id: item.hostId, json: JSON.stringify(remaining), fetched_at: item.fetchedAt, opened_at: item.openedAt });
    }
    upsert.run({ key, owner, repo, host_id: hostId, json: JSON.stringify(stack), fetched_at: fetchedAt, opened_at: related[0]?.openedAt ?? openedAt });
    return key;
  });
  return { list, forPr, save, get: (key: string) => { const row = byKey.get(key); return row ? decode(row) : undefined; }, remove: (key: string) => drop.run(key) };
}
