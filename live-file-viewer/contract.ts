import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_BYTES = 5 * 1024 * 1024;
const source = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().optional(),
  })
  .strict();
const file = z.object({ path: z.string().min(1), source }).strict();
export type FileRequest = z.infer<typeof file>;
export const rpcContract = defineRpcContract({
  read: {
    input: file,
    output: z.object({
      content: z.string(),
      sha256: z.string(),
      rootPath: z.string(),
      readOnly: z.boolean(),
    }),
  },
  assets: {
    input: file,
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
  },
  write: {
    input: file.extend({
      content: z.string().max(MAX_BYTES),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
});
