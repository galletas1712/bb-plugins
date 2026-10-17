import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./contract";
import { Library } from "./library";
import { Recall } from "./qmd";
import { saveRecord } from "./capture";
import { idSchema, saveSchema, searchSchema } from "./schema";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    libraryPath: {
      type: "string",
      label: "Library directory on the BB server (reload after changing)",
      default: path.join(homedir(), ".local", "share", "bb-knowledge"),
      experimental_schema: z
        .string()
        .refine(path.isAbsolute, "Use an absolute server path"),
    },
    qmdExecutable: {
      type: "string",
      label: "QMD executable on the BB server (reload after changing)",
      default: "qmd",
    },
  });
  const config = await settings.get();
  const library = new Library(config.libraryPath);
  const abort = new AbortController();
  bb.onDispose(() => abort.abort());
  const recall = new Recall(library, config.qmdExecutable, abort.signal);
  const read = async (id: string) => {
    const record = library.read(id);
    return {
      record,
      path: library.bodyPath(id),
      hostId: (await bb.sdk.system.config()).primaryHostId,
    };
  };
  bb.rpc.register(rpcContract, {
    status: () => ({
      ...config,
      records: library.all().length,
    }),
    search: (input) => recall.search(input),
    read: ({ id }) => read(id),
    save: (input) => saveRecord(bb, library, input),
    edit: (input) => {
      const previous = library.read(input.id);
      const record = library.save(
        saveSchema.parse(input),
        previous.projectId,
        [],
        previous.source,
      );
      bb.realtime.publish("changed", {});
      return record;
    },
    delete: ({ id }) => {
      const result = library.delete(id);
      bb.realtime.publish("changed", {});
      return result;
    },
    sync: ({ embed }) => recall.sync(embed),
  });

  bb.agents.registerTool({
    name: "knowledge_recall",
    description:
      "Find saved project context, findings, decisions, procedures, and experiment evidence. Searches this project plus global records by default. Keyword search uses QMD BM25. Hybrid search uses QMD local models. Each result includes the absolute path of the record's body.md: read it directly for the full text, and grep the artifacts folder next to it for detail that is not in the body.",
    parameters: searchSchema,
    async execute(input, context) {
      return JSON.stringify(
        await recall.search({
          ...input,
          projectId: input.projectId ?? context.projectId,
        }),
      );
    },
  });
  bb.agents.registerTool({
    name: "knowledge_save",
    description:
      "Create a record, fully rewrite one, or attach evidence files. Records are plain folders: body.md (frontmatter plus Markdown) and artifacts/. To update an existing record's text, prefer editing its body.md directly with your file tools instead of calling this tool. Source defaults to the current thread at save time. Set threadId or sourceSequence only to cite a different thread or a specific point in its history.",
    parameters: saveSchema,
    async execute(input, context) {
      return JSON.stringify(
        await saveRecord(bb, library, input, context.threadId),
      );
    },
  });
  bb.agents.registerTool({
    name: "knowledge_delete",
    description:
      "Move a record to the library trash. The record disappears from search and listings, but its body and artifacts stay on disk and can be recovered. Use for temporary records whose subject is finished, such as PR review notes after the PR merges, and only when the record has no lasting value.",
    parameters: z.object({ id: idSchema }),
    async execute({ id }) {
      const result = library.delete(id);
      bb.realtime.publish("changed", {});
      return JSON.stringify(result);
    },
  });
  const json = { type: "boolean", description: "Emit JSON" } as const;
  const reply = (value: unknown) => ({
    exitCode: 0,
    stdout: JSON.stringify(value, null, 2),
  });
  bb.cli.register(
    defineCli({
      name: "knowledge",
      summary: "Recall and preserve useful results in a durable file library",
      commands: {
        status: cliCommand({
          summary: "Show the library location and record count",
          options: { json },
          run: () =>
            reply({
              ...config,
              records: library.all().length,
            }),
        }),
        search: cliCommand({
          summary: "Recall current project and global records with QMD",
          options: {
            json,
            project: {
              type: "string",
              description: "Project ID, defaults to current project",
            },
            all: { type: "boolean", description: "Search all projects" },
            engine: {
              type: "enum",
              values: ["keyword", "hybrid"],
              default: "keyword",
              description: "QMD search mode",
            },
            limit: {
              type: "integer",
              min: 1,
              max: 50,
              default: 10,
              description: "Result count",
            },
            offset: {
              type: "integer",
              min: 0,
              max: 1000000,
              default: 0,
              description: "Result offset",
            },
          },
          constraints: [{ kind: "at-most-one", options: ["all", "project"] }],
          positionals: [
            {
              name: "query",
              description: "Search phrase. Omit to browse",
              required: false,
            },
          ],
          async run({ options, positionals }, context) {
            return reply(
              await recall.search(
                searchSchema.parse({
                  query: positionals.query ?? "",
                  projectId: options.all
                    ? undefined
                    : (options.project ?? context.projectId),
                  limit: options.limit,
                  offset: options.offset,
                  engine: options.engine,
                }),
              ),
            );
          },
        }),
        read: cliCommand({
          summary: "Read a saved record and the path of its body.md",
          options: { json },
          positionals: [
            { name: "id", description: "Record ID", required: true },
          ],
          run: async ({ positionals }) => reply(await read(positionals.id)),
        }),
        save: cliCommand({
          summary:
            "Create or rewrite a record and preserve its evidence. To update text, prefer editing body.md directly",
          options: {
            json,
            input: {
              type: "string",
              stdin: true,
              description:
                "Capture JSON on stdin, one line, capped at 16 KiB",
            },
            inputFile: {
              type: "string",
              description:
                "Read capture JSON from this file instead of stdin. No size cap",
            },
          },
          constraints: [
            { kind: "at-most-one", options: ["input", "input-file"] },
          ],
          async run({ options }, context) {
            const raw = options.inputFile
              ? fs.readFileSync(options.inputFile, "utf8")
              : options.input;
            if (!raw)
              throw new Error(
                "Provide --input-stdin or --input-file. Bodies over 16 KiB need --input-file.",
              );
            return reply(
              await saveRecord(
                bb,
                library,
                saveSchema.parse(JSON.parse(raw)),
                context.threadId,
              ),
            );
          },
        }),
        delete: cliCommand({
          summary:
            "Move a record to the library trash (recoverable; body and artifacts stay on disk)",
          options: { json },
          positionals: [
            { name: "id", description: "Record ID", required: true },
          ],
          async run({ positionals }) {
            const result = library.delete(positionals.id);
            bb.realtime.publish("changed", {});
            return reply(result);
          },
        }),
        sync: cliCommand({
          summary: "Rebuild the QMD index from the record files",
          options: {
            json,
            embed: {
              type: "boolean",
              description:
                "Also build embeddings. QMD may download local models",
            },
          },
          run: async ({ options }) => reply(await recall.sync(options.embed)),
        }),
      },
    }),
  );
}
