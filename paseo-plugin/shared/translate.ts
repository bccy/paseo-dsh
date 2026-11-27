/**
 * Shared RPC contract for automatic Chinese translation of English
 * reasoning/thinking rows (`InlineThinking`).
 *
 * Strictly runtime-neutral (`@getpaseo/plugin` + `zod` only; zero `node:*`
 * imports, Hermes/React Native safe).
 *
 * @module dsh-paseo/shared/translate
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export {
  needsChineseTranslation,
  splitTranslationChunks,
  type TranslationChunkPlan,
} from "./translate-text";

export const translateThinkingRpc = defineRpc({
  name: "thinking.translate",
  input: z
    .object({
      text: z.string().min(1).max(20_000),
      target: z.enum(["zh-CN"]).default("zh-CN"),
    })
    .strict(),
  output: z.object({
    translated: z.string(),
    cached: z.boolean(),
    provider: z.string(),
  }),
});
