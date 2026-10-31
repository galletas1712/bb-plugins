import { z } from "zod";

export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
export const titleSchema = z.string().trim().min(1).max(200);
export const bodySchema = z.string().trim().min(1).max(60000);
export const artifactNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
export const explainerTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Use a short, single-line title",
  );
export const explainerRefSchema = z.object({
  recordId: idSchema,
  name: artifactNameSchema,
});
export const threadExplainerSchema = explainerRefSchema.extend({
  title: explainerTitleSchema,
  addedAt: z.iso.datetime(),
});
export type ExplainerRef = z.infer<typeof explainerRefSchema>;
export type ThreadExplainer = z.infer<typeof threadExplainerSchema>;
export const isHtml = (name: string) => /\.html?$/i.test(name);

export const saveSchema = z
  .object({
    id: idSchema,
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    threadId: idSchema.optional(),
    sourceSequence: z.number().int().min(0).optional(),
    global: z.boolean().optional(),
    present: z
      .array(
        z
          .object({ name: artifactNameSchema, title: explainerTitleSchema })
          .strict(),
      )
      .max(30)
      .default([]),
    artifacts: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            name: artifactNameSchema,
            source: z
              .enum(["workspace", "thread-storage"])
              .default("workspace")
              .describe(
                "Where to read the file from. The plugin copies the bytes into the library, so the artifact survives the source workspace or thread.",
              ),
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
    if (new Set(value.present.map((a) => a.name)).size !== value.present.length)
      ctx.addIssue({
        code: "custom",
        path: ["present"],
        message: "Presented names must be unique",
      });
    if ((value.title === undefined) !== (value.body === undefined))
      ctx.addIssue({
        code: "custom",
        message:
          "Provide both title and body, or omit both for an existing record",
      });
    if (value.title === undefined && value.sourceSequence !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "sourceSequence requires record text",
      });
  });
export type SaveInput = z.infer<typeof saveSchema>;

export const artifactSchema = z.object({
  name: artifactNameSchema,
  file: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(0),
  sourcePath: z.string(),
  hostId: z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;

/** A record is a folder: body.md (frontmatter + Markdown) plus artifacts/.
 * There are no versions and no HEAD pointer. The body file is canonical and
 * agents edit it directly; updatedAt comes from the body or manifest mtime. */
export const recordSchema = z.object({
  id: idSchema,
  title: titleSchema,
  body: z.string(),
  projectId: z.string().nullable(),
  source: z.object({ threadId: idSchema, sequence: z.number().int().min(0) }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  artifacts: z.array(artifactSchema),
  artifactError: z.string().optional(),
});
export type KnowledgeRecord = z.infer<typeof recordSchema>;
export const saveResultSchema = recordSchema.extend({
  presented: z.array(
    z.object({
      name: artifactNameSchema,
      attached: z.boolean(),
      reference: z.string(),
      error: z.string().optional(),
    }),
  ),
});
export const searchSchema = z
  .object({
    query: z
      .string()
      .max(1000)
      .default("")
      .describe(
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
  .omit({ body: true, artifacts: true })
  .extend({
    snippet: z.string(),
    artifactCount: z.number(),
    path: z.string().describe("Absolute path of the record's body.md"),
  });
export type RecordSummary = z.infer<typeof summarySchema>;
