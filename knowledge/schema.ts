import { z } from "zod";

export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const text = z.string().trim().min(1).max(200);

export const saveSchema = z
  .object({
    id: idSchema,
    expectedVersion: z.number().int().min(0),
    title: text,
    body: z.string().trim().min(1).max(60000),
    threadId: idSchema.optional(),
    sourceSequence: z.number().int().min(0).optional(),
    global: z.boolean().default(false),
    artifacts: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),
            source: z
              .enum(["workspace", "thread-storage"])
              .default("workspace"),
          })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024)
      ctx.addIssue({
        code: "custom",
        message:
          "Record text and metadata must fit within 256 KiB. Attach larger datasets as files.",
      });
    if (
      new Set(value.artifacts.map((a) => a.name)).size !==
      value.artifacts.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Artifact names must be unique",
      });
  });
export type SaveInput = z.infer<typeof saveSchema>;

export const artifactSchema = z.object({
  name: z.string(),
  file: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(0),
  sourcePath: z.string(),
  hostId: z.string(),
});
export const recordSchema = z.object({
  schemaVersion: z.literal(2),
  id: idSchema,
  version: z.number().int().min(1),
  requestHash: z.string(),
  title: text,
  body: z.string(),
  projectId: z.string().nullable(),
  source: z.object({ threadId: idSchema, sequence: z.number().int().min(0) }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  artifacts: z.array(artifactSchema),
});
export type KnowledgeRecord = z.infer<typeof recordSchema>;
export const searchSchema = z
  .object({
    query: z.string().max(1000).default("").describe(
      "Search one topic with a few distinctive terms. If no results, try a narrower term or hybrid search before concluding no record exists.",
    ),
    projectId: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).default(0),
    engine: z.enum(["keyword", "hybrid"]).default("keyword"),
  })
  .strict();
export type SearchInput = z.infer<typeof searchSchema>;
export const summarySchema = recordSchema
  .omit({ body: true, requestHash: true, artifacts: true })
  .extend({ snippet: z.string(), artifactCount: z.number() });
export type RecordSummary = z.infer<typeof summarySchema>;
