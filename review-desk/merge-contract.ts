import { z } from "zod";

export const mergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export const mergeScopeSchema = z.object({
  headSha: z.string().min(1),
  baseRefName: z.string().min(1),
  prs: z.array(z.object({ number: z.number().int().positive(), headSha: z.string().min(1) })).max(100),
});
export const mergeOptionsSchema = mergeScopeSchema.extend({
  methods: z.array(mergeMethodSchema),
  defaultMethod: mergeMethodSchema.nullable(),
  reason: z.string().nullable(),
});
export const mergeInputSchema = z.object({ method: mergeMethodSchema, expected: mergeScopeSchema });
export const mergeResultSchema = z.object({
  status: z.enum(["pending", "merged", "enqueued", "failed"]),
  requestId: z.string().nullable(),
  message: z.string(),
});
export type MergeOptions = z.infer<typeof mergeOptionsSchema>;
export type MergeResult = z.infer<typeof mergeResultSchema>;
