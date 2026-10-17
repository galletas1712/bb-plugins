#!/usr/bin/env node
/**
 * Migrate a versioned knowledge library (record.json + HEAD + versions/) to
 * the file-first layout: records/<id>/body.md plus artifacts.json.
 *
 * Everything removed (HEAD files, versions/ dirs, the search/ projection,
 * records/.trash) moves to <root>/.trash/migration-<timestamp>/, so the
 * migration is reversible. Artifacts stay in place.
 *
 * Usage: node scripts/migrate-to-files.mjs [libraryRoot]
 */
import fs from "node:fs";
import path from "node:path";

const root =
  process.argv[2] ?? path.join(process.env.HOME, ".local/share/bb-knowledge");
const recordsDir = path.join(root, "records");
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const trash = path.join(root, ".trash", `migration-${stamp}`);

const FRONTMATTER = (record) => {
  const metadata = {
    id: record.id,
    title: record.title,
    project: record.projectId,
    created: record.createdAt,
    source_thread: record.source.threadId,
    source_sequence: record.source.sequence,
  };
  const lines = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${lines}\n---\n\n${record.body}\n`;
};

let migrated = 0;
const skipped = [];
fs.mkdirSync(trash, { recursive: true, mode: 0o700 });

for (const entry of fs.readdirSync(recordsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const dir = path.join(recordsDir, entry.name);
  const headFile = path.join(dir, "HEAD");
  if (fs.existsSync(path.join(dir, "body.md"))) {
    skipped.push(`${entry.name}: already migrated`);
    continue;
  }
  if (!fs.existsSync(headFile)) {
    skipped.push(`${entry.name}: no HEAD`);
    continue;
  }
  const head = fs.readFileSync(headFile, "utf8").trim();
  const record = JSON.parse(
    fs.readFileSync(path.join(dir, "versions", head, "record.json"), "utf8"),
  );
  const bodyFile = path.join(dir, "body.md");
  fs.writeFileSync(bodyFile, FRONTMATTER(record), { mode: 0o600 });
  // Preserve the freshness signal: updatedAt is derived from the file mtime.
  const mtime = new Date(record.updatedAt);
  fs.utimesSync(bodyFile, mtime, mtime);
  if (record.artifacts?.length)
    fs.writeFileSync(
      path.join(dir, "artifacts.json"),
      JSON.stringify(record.artifacts, null, 2) + "\n",
      { mode: 0o600 },
    );
  fs.renameSync(headFile, path.join(trash, `${entry.name}-HEAD`));
  fs.renameSync(
    path.join(dir, "versions"),
    path.join(trash, `${entry.name}-versions`),
  );
  migrated++;
}

for (const stale of ["search", path.join("records", ".trash")]) {
  const full = path.join(root, stale);
  if (fs.existsSync(full))
    fs.renameSync(full, path.join(trash, stale.replaceAll("/", "_")));
}

console.log(`migrated: ${migrated}`);
console.log(`skipped: ${skipped.length}`);
for (const line of skipped.slice(0, 10)) console.log(`  ${line}`);
console.log(`old layout preserved under ${trash}`);
