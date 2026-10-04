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
      reportPath: library.reportPath(record),
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
    sync: ({ embed }) => recall.sync(embed),
  });

  bb.agents.registerTool({
    name: "knowledge_recall",
    description:
      "Find saved project context, findings, decisions, procedures, and experiment evidence. Searches this project plus global records by default. Keyword search uses QMD BM25. Hybrid search uses QMD local models.",
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
    name: "knowledge_read",
    description:
      "Read the full saved record and its evidence metadata. Check conditions, limitations, and source dates before reuse.",
    parameters: z.object({ id: idSchema }),
    async execute({ id }) {
      return JSON.stringify(await read(id));
    },
  });
  bb.agents.registerTool({
    name: "knowledge_save",
    description:
      "Update a matching record first when useful context or evidence is missing or outdated. Read it, keep its id, and pass its current version as expectedVersion with the revised title and full Markdown body. Preserve useful older context and sources. Create with expectedVersion=0 when no existing record fits. Reuse adequately covered material without saving. Source defaults to the current thread at save time. Set threadId or sourceSequence only to cite a different thread or a specific point in its history.",
    parameters: saveSchema,
    async execute(input, context) {
      return JSON.stringify(
        await saveRecord(bb, library, input, context.threadId),
      );
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
          summary: "Read a saved result and its current version",
          options: { json },
          positionals: [
            { name: "id", description: "Record ID", required: true },
          ],
          run: async ({ positionals }) => reply(await read(positionals.id)),
        }),
        save: cliCommand({
          summary: "Save a JSON record and preserve its evidence",
          options: {
            json,
            input: {
              type: "string",
              required: true,
              stdin: true,
              description:
                "Capture JSON. Use --input-stdin < capture.json to avoid shell quoting",
            },
          },
          async run({ options }, context) {
            return reply(
              await saveRecord(
                bb,
                library,
                saveSchema.parse(JSON.parse(options.input)),
                context.threadId,
              ),
            );
          },
        }),
        sync: cliCommand({
          summary: "Rebuild the QMD index from durable files",
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
