import type Database from "better-sqlite3";

interface Entry { json: string; fetched_at: number }

/** Persistent reads with background refresh, shared requests, and bounded storage. */
export function createReadCache(db: Database.Database, exists: (id: string) => boolean, changed: (id: string, key: string) => void, failed: (cause: unknown) => void) {
  const get = db.prepare<[string, string], Entry>("SELECT json, fetched_at FROM read_cache WHERE review_id = ? AND key = ?");
  const put = db.prepare("INSERT INTO read_cache (review_id, key, json, bytes, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(review_id, key) DO UPDATE SET json = excluded.json, bytes = excluded.bytes, fetched_at = excluded.fetched_at");
  const requests = new Map<string, Promise<unknown>>();
  let disposed = false;
  function peek<T>(id: string, key: string): T | null {
    const entry = get.get(id, key);
    return entry ? JSON.parse(entry.json) as T : null;
  }
  function write(id: string, key: string, value: unknown) {
    if (disposed || !exists(id)) return;
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json);
    if (bytes > 4 * 1024 * 1024) return;
    const previous = get.get(id, key);
    put.run(id, key, json, bytes, Date.now());
    // Retain at most 64 MiB and 2048 entries across all reviews.
    db.exec(`DELETE FROM read_cache WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, SUM(bytes) OVER (ORDER BY fetched_at DESC, rowid DESC) AS total,
          ROW_NUMBER() OVER (ORDER BY fetched_at DESC, rowid DESC) AS position FROM read_cache
      ) WHERE total > 67108864 OR position > 2048
    )`);
    if (previous?.json !== json) changed(id, key);
  }
  async function refresh<T>(id: string, key: string, load: () => Promise<T>): Promise<T> {
    const identity = JSON.stringify([id, key]);
    const existing = requests.get(identity);
    if (existing) return existing as Promise<T>;
    const request = Promise.resolve().then(load).then((value) => {
      if (requests.get(identity) === request) write(id, key, value);
      return value;
    }).finally(() => { if (requests.get(identity) === request) requests.delete(identity); });
    requests.set(identity, request);
    return request;
  }
  return {
    peek,
    read<T>(id: string, key: string, load: () => Promise<T>, maxAge: number, fresh = false): Promise<T> {
      const entry = get.get(id, key);
      if (!entry || fresh) return refresh(id, key, load);
      if (Date.now() - entry.fetched_at >= maxAge) void refresh(id, key, load).catch((cause) => { if (!disposed) failed(cause); });
      return Promise.resolve(JSON.parse(entry.json) as T);
    },
    update(id: string, key: string, value: unknown) {
      requests.delete(JSON.stringify([id, key]));
      write(id, key, value);
    },
    remove(id: string) {
      for (const identity of requests.keys()) if ((JSON.parse(identity) as string[])[0] === id) requests.delete(identity);
      db.prepare("DELETE FROM read_cache WHERE review_id = ?").run(id);
    },
    dispose() { disposed = true; requests.clear(); },
  };
}
