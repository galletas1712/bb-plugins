import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  artifactSchema,
  idSchema,
  type Artifact,
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

const FRONTMATTER_KEYS = [
  "id",
  "title",
  "project",
  "created",
  "source_thread",
  "source_sequence",
] as const;

/** The canonical record file: JSON-valued frontmatter lines between ---
 * fences, then the Markdown body. Agents edit this file directly. */
function serialize(record: KnowledgeRecord) {
  const metadata = {
    id: record.id,
    title: record.title,
    project: record.projectId,
    created: record.createdAt,
    source_thread: record.source.threadId,
    source_sequence: record.source.sequence,
  };
  const frontmatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n${record.body}\n`;
}

function parse(id: string, raw: string, updatedAt: string) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) throw new Error(`Malformed body.md for ${id}`);
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) continue;
    fields[key] = JSON.parse(line.slice(separator + 2));
  }
  if (typeof fields.title !== "string" || typeof fields.created !== "string")
    throw new Error(`Malformed frontmatter for ${id}`);
  return {
    id,
    title: fields.title,
    body: match[2].replace(/\n$/, ""),
    projectId: (fields.project as string | null) ?? null,
    source: {
      threadId: (fields.source_thread as string) ?? "unknown",
      sequence: (fields.source_sequence as number) ?? 0,
    },
    createdAt: fields.created,
    updatedAt,
  };
}

/** A record is a folder: body.md plus artifacts/ and an artifacts.json
 * sidecar. QMD indexes body.md files directly, so there is no search
 * projection, no versions, and no HEAD pointer. */
export class Library {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root))
      throw new Error("libraryPath must be an absolute path on the BB server");
    fs.mkdirSync(path.join(root, "records"), { recursive: true, mode: 0o700 });
  }

  private directory(id: string) {
    return path.join(this.root, "records", idSchema.parse(id));
  }

  bodyPath(id: string) {
    return path.join(this.directory(id), "body.md");
  }

  private readArtifacts(dir: string): Artifact[] {
    const file = path.join(dir, "artifacts.json");
    if (!fs.existsSync(file)) return [];
    return artifactSchema.array().parse(JSON.parse(fs.readFileSync(file, "utf8")));
  }

  read(id: string): KnowledgeRecord {
    const file = this.bodyPath(id);
    const raw = fs.readFileSync(file, "utf8");
    const updatedAt = fs.statSync(file).mtime.toISOString();
    const parsed = parse(id, raw, updatedAt);
    return { ...parsed, artifacts: this.readArtifacts(path.dirname(file)) };
  }

  all(): KnowledgeRecord[] {
    return fs
      .readdirSync(path.join(this.root, "records"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .filter((entry) => fs.existsSync(this.bodyPath(entry.name)))
      .map((entry) => this.read(entry.name));
  }

  /** Create or fully replace a record. Small updates should edit body.md
   * directly instead of going through this method. */
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
    const dir = this.directory(input.id);
    const previous = fs.existsSync(this.bodyPath(input.id))
      ? this.read(input.id)
      : null;
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
      id: input.id,
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
    atomicWrite(this.bodyPath(input.id), serialize(record));
    if (record.artifacts.length)
      atomicWrite(
        path.join(dir, "artifacts.json"),
        JSON.stringify(record.artifacts, null, 2) + "\n",
      );
    return record;
  }

  /** Move a record into a trash folder at the library root, outside the QMD
   * collection. Recover by moving the folder back into records/. */
  delete(id: string): { id: string; trashedTo: string } {
    const dir = this.directory(id);
    if (!fs.existsSync(this.bodyPath(id)))
      throw new Error(`No record named ${id}.`);
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const trashedTo = path.join(this.root, ".trash", `${id}-${stamp}`);
    fs.mkdirSync(path.dirname(trashedTo), { recursive: true, mode: 0o700 });
    fs.renameSync(dir, trashedTo);
    return { id, trashedTo };
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
        const { body, artifacts, ...summary } = record;
        return {
          ...summary,
          artifactCount: artifacts.length,
          snippet: body.slice(0, 300),
          path: this.bodyPath(record.id),
        };
      });
    return { records, total: matches.length };
  }
}
