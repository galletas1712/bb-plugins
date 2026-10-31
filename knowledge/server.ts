import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./contract";
import { Library } from "./library";
import { Recall } from "./qmd";
import { saveRecord } from "./capture";
import { Explainers } from "./explainers";
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
  const explainers = new Explainers(bb, library);
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
    listThreadExplainers: ({ threadId }) => explainers.list(threadId),
    readExplainer: (ref) => explainers.read(ref),
    attachThreadExplainer: ({ threadId, title, ...ref }) =>
      explainers.attach(threadId, ref, title),
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

  bb.agents.contributeInstructions(
    () =>
      "Use saved Explainers when a visual would substantially clarify the answer or the user requests one. Use knowledge_save with explicit present entries and short titles. When presenting, reply with the returned reference and one short takeaway, keeping the detailed explanation in the Explainer. Load knowledge-library for authoring and reuse instructions.",
  );

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
      "Create or rewrite a record, attach evidence, or present saved HTML in the current thread's Explainers sidebar. Existing records may omit title/body. Use present: [{name, title}] explicitly for new or reused HTML. It returns a compact opener reference and whether attachment succeeded. Record text is body.md, prefer editing it directly. threadId selects the source of bytes and new record text, never the destination for present. Attachment-only saves preserve provenance and scope.",
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
          options: { json },
          positionals: [
            {
              name: "file",
              description:
                "Capture JSON file. Write it with jq or your file tools, then pass the path",
              required: true,
            },
          ],
          async run({ positionals }, context) {
            return reply(
              await saveRecord(
                bb,
                library,
                saveSchema.parse(
                  JSON.parse(fs.readFileSync(positionals.file, "utf8")),
                ),
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
