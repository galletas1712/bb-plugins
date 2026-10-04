import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  idSchema,
  recordSchema,
  type KnowledgeRecord,
  type SaveInput,
  type SearchInput,
  type RecordSummary,
} from "./schema";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function atomicWrite(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function markdown(record: KnowledgeRecord) {
  const metadata = {
    id: record.id,
    title: record.title,
    project: record.projectId,
    updated: record.updatedAt,
  };
  const frontmatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return (
    `---\n${frontmatter}\n---\n\n# ${record.title}\n\n${record.body}\n\n` +
    `## Source\n\n@thread:${record.source.threadId}, through event ${record.source.sequence}.\n\n` +
    (record.artifacts.length
      ? `## Evidence\n\n${record.artifacts.map((a) => `- [${a.name}](../../${a.file}) · SHA-256 \`${a.sha256}\``).join("\n")}\n`
      : "")
  );
}

/** Canonical version folders are immutable. HEAD publishes a complete version in one rename. */
export class Library {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root))
      throw new Error("libraryPath must be an absolute path on the BB server");
    fs.mkdirSync(path.join(root, "records"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, "search"), { recursive: true, mode: 0o700 });
  }

  private directory(id: string) {
    return path.join(this.root, "records", idSchema.parse(id));
  }

  read(id: string): KnowledgeRecord {
    const dir = this.directory(id);
    const version = fs.readFileSync(path.join(dir, "HEAD"), "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(version))
      throw new Error(`Invalid HEAD for ${id}`);
    const record = recordSchema.parse(
      JSON.parse(
        fs.readFileSync(
          path.join(dir, "versions", version, "record.json"),
          "utf8",
        ),
      ),
    );
    if (record.id !== id || record.version !== Number(version))
      throw new Error(`Invalid version for ${id}`);
    return record;
  }

  all(): KnowledgeRecord[] {
    return fs
      .readdirSync(path.join(this.root, "records"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .filter((entry) =>
        fs.existsSync(path.join(this.directory(entry.name), "HEAD")),
      )
      .map((entry) => this.read(entry.name));
  }

  reportPath(record: KnowledgeRecord) {
    return path.join(
      this.directory(record.id),
      "versions",
      String(record.version),
      "report.md",
    );
  }

  save(
    input: SaveInput,
    projectId: string | null,
    evidence: Array<{
      name: string;
      bytes: Buffer;
      hostId: string;
      sourcePath: string;
    }>,
    source: KnowledgeRecord["source"],
  ): KnowledgeRecord {
    // No await between the version check and HEAD publication. Calls in one server
    // generation cannot interleave, including while a replacement plugin loads.
    const dir = this.directory(input.id);
    const previous = fs.existsSync(path.join(dir, "HEAD"))
      ? this.read(input.id)
      : null;
    // Keep retries stable when an automatic source sequence advances between calls.
    const requestHash = hash(
      JSON.stringify({
        input,
        sourceThreadId: source.threadId,
        projectId,
        evidence: evidence.map((a) => ({
          name: a.name,
          sha256: hash(a.bytes),
        })),
      }),
    );
    if (previous?.requestHash === requestHash) return previous;
    if ((previous?.version ?? 0) !== input.expectedVersion)
      throw new Error(
        `Version conflict for ${input.id}. Read the record and use its current expectedVersion.`,
      );
    if (previous && previous.projectId !== projectId)
      throw new Error("A record cannot move between project and global scopes");
    const artifacts = evidence.map((a) => {
      const sha256 = hash(a.bytes);
      const file = `artifacts/${sha256}-${a.name}`;
      atomicWrite(path.join(dir, file), a.bytes);
      return {
        name: a.name,
        file,
        sha256,
        bytes: a.bytes.length,
        sourcePath: a.sourcePath,
        hostId: a.hostId,
      };
    });
    const now = new Date().toISOString();
    const record: KnowledgeRecord = {
      schemaVersion: 2,
      id: input.id,
      version: (previous?.version ?? 0) + 1,
      requestHash,
      title: input.title,
      body: input.body,
      projectId,
      source,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      artifacts: [
        ...(previous?.artifacts ?? []).filter(
          (a) => !artifacts.some((b) => b.name === a.name),
        ),
        ...artifacts,
      ],
    };
    const versionDir = path.join(dir, "versions", String(record.version));
    atomicWrite(
      path.join(versionDir, "record.json"),
      JSON.stringify(record, null, 2) + "\n",
    );
    atomicWrite(path.join(versionDir, "report.md"), markdown(record));
    atomicWrite(path.join(dir, "HEAD"), String(record.version));
    return record;
  }

  search(input: SearchInput, rankedIds?: string[]) {
    const all = this.all();
    const matches = all
      .filter(
        (r) =>
          !input.projectId ||
          r.projectId === input.projectId ||
          r.projectId === null,
      )
      .map((record) => {
        const score = rankedIds
          ? rankedIds.length - rankedIds.indexOf(record.id)
          : 0;
        return { record, score };
      })
      .filter(({ record }) => !rankedIds || rankedIds.includes(record.id))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.record.updatedAt.localeCompare(a.record.updatedAt) ||
          a.record.id.localeCompare(b.record.id),
      );
    const records: RecordSummary[] = matches
      .slice(input.offset, input.offset + input.limit)
      .map(({ record }) => {
        const { body, requestHash: _, artifacts, ...summary } = record;
        return {
          ...summary,
          artifactCount: artifacts.length,
          snippet: body.slice(0, 300),
        };
      });
    return { records, total: matches.length };
  }

  rebuildSearch() {
    const records = this.all();
    const wanted = new Set(records.map((r) => `${r.id}.md`));
    for (const file of fs.readdirSync(path.join(this.root, "search"))) {
      if (file.endsWith(".md") && !wanted.has(file))
        fs.unlinkSync(path.join(this.root, "search", file));
    }
    for (const record of records) {
      const file = path.join(this.root, "search", `${record.id}.md`);
      // Evidence links in the search projection point back into canonical storage.
      atomicWrite(
        file,
        markdown(record).replaceAll(
          "](../../artifacts/",
          `](../records/${record.id}/artifacts/`,
        ),
      );
    }
    return records.length;
  }
}
