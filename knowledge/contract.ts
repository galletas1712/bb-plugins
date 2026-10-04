import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  idSchema,
  recordSchema,
  saveSchema,
  searchSchema,
  summarySchema,
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
      reportPath: z.string(),
      hostId: z.string().nullable(),
    }),
  },
  save: { input: saveSchema, output: recordSchema },
  edit: {
    input: z
      .object({
        id: idSchema,
        expectedVersion: saveSchema.shape.expectedVersion,
        title: saveSchema.shape.title,
        body: saveSchema.shape.body,
      })
      .strict(),
    output: recordSchema,
  },
  sync: {
    input: z.object({ embed: z.boolean().default(false) }),
    output: z.object({ indexed: z.number(), embedded: z.boolean() }),
  },
});
