import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import { Library } from "./library";
import type { SearchInput } from "./schema";

const resultsSchema = z.array(
  z.object({ file: z.string(), score: z.number() }),
);

/** Owns one isolated, rebuildable QMD index. Canonical records decide project scope. */
export class Recall {
  private pending: Promise<unknown> = Promise.resolve();
  private indexedSignature: string | null = null;
  private embeddedSignature: string | null = null;

  constructor(
    private library: Library,
    private executable: string,
    private signal: AbortSignal,
  ) {}

  private run(args: string[]): Promise<string> {
    const configDir = path.join(this.library.root, ".qmd");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "knowledge.yml"),
      JSON.stringify({
        collections: {
          knowledge: {
            path: path.join(this.library.root, "search"),
            pattern: "*.md",
          },
        },
      }),
    );
    return new Promise((resolve, reject) => {
      execFile(
        this.executable,
        ["--index", "knowledge", ...args],
        {
          cwd: this.library.root,
          signal: this.signal,
          timeout: 180000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            QMD_CONFIG_DIR: configDir,
            XDG_CACHE_HOME: path.join(configDir, "cache"),
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(
                `QMD failed: ${stderr.trim().slice(-1500) || error.message}. Install @tobilu/qmd on the BB server and set qmdExecutable if needed.`,
              ),
            );
          else resolve(stdout);
        },
      );
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private async refresh(force = false, embed = false) {
    const signature = JSON.stringify(
      this.library.all().map((r) => [r.id, r.version]),
    );
    if (force || signature !== this.indexedSignature) {
      this.library.rebuildSearch();
      await this.run(["update"]);
      this.indexedSignature = signature;
    }
    if (embed && (force || signature !== this.embeddedSignature)) {
      await this.run(["embed"]);
      this.embeddedSignature = signature;
    }
  }

  sync(embed = false) {
    return this.exclusive(async () => {
      await this.refresh(true, embed);
      return { indexed: this.library.all().length, embedded: embed };
    });
  }

  search(input: SearchInput) {
    return this.exclusive(async () => {
      // An empty query is a library listing, not a relevance search.
      if (!input.query.trim()) return this.library.search(input);
      await this.refresh(false, input.engine === "hybrid");
      const output = await this.run([
        input.engine === "hybrid" ? "query" : "search",
        "-c",
        "knowledge",
        "--json",
        "-n",
        "200",
        "--",
        input.query,
      ]);
      const rows = resultsSchema.parse(JSON.parse(output));
      const ids = [
        ...new Set(
          rows
            .map((row) => {
              const url = new URL(row.file);
              return url.protocol === "qmd:" && url.hostname === "knowledge"
                ? /^\/([a-zA-Z0-9_-]+)\.md$/.exec(url.pathname)?.[1]
                : undefined;
            })
            .filter((id): id is string => !!id),
        ),
      ];
      return this.library.search(input, ids);
    });
  }
}
