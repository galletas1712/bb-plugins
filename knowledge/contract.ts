import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  idSchema,
  recordSchema,
  saveSchema,
  searchSchema,
  summarySchema,
  titleSchema,
  bodySchema,
  explainerRefSchema,
  explainerTitleSchema,
  threadExplainerSchema,
  saveResultSchema,
} from "./schema";

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      libraryPath: z.string(),
      qmdExecutable: z.string(),
      records: z.number(),
    }),
  },
  search: {
    input: searchSchema,
    output: z.object({ records: z.array(summarySchema), total: z.number() }),
  },
  read: {
    input: z.object({ id: idSchema }),
    output: z.object({
      record: recordSchema,
      path: z.string(),
      hostId: z.string().nullable(),
    }),
  },
  save: { input: saveSchema, output: saveResultSchema },
  listThreadExplainers: {
    input: z.object({ threadId: idSchema }).strict(),
    output: z.array(threadExplainerSchema),
  },
  readExplainer: {
    input: explainerRefSchema.strict(),
    output: z.object({
      html: z.string(),
      sha256: z.string(),
      path: z.string(),
      hostId: z.string().nullable(),
    }),
  },
  attachThreadExplainer: {
    input: explainerRefSchema
      .extend({ threadId: idSchema, title: explainerTitleSchema })
      .strict(),
    output: threadExplainerSchema,
  },
  edit: {
    input: z
      .object({
        id: idSchema,
        title: titleSchema,
        body: bodySchema,
      })
      .strict(),
    output: recordSchema,
  },
  delete: {
    input: z.object({ id: idSchema }),
    output: z.object({ id: z.string(), trashedTo: z.string() }),
  },
  sync: {
    input: z.object({ embed: z.boolean().default(false) }),
    output: z.object({ indexed: z.number(), embedded: z.boolean() }),
  },
});
