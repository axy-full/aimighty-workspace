/**
 * The product image for "Create with template": one tenant-owned original
 * (upload or completed generation), validated, resolved and imported exactly
 * like a Generate reference — the same tables, claims and limits, expressed as
 * a one-media image request so nothing here re-implements source handling.
 */
import type { Transaction } from "@libsql/client";
import type { ConsumerGenerationInput } from "./generation-contract";
import {
  resolveConsumerGenerationImport,
  resolveConsumerGenerationSources,
  validateConsumerGenerationSources,
} from "./generation-sources";
import { parseConsumerMarketingTemplateInput } from "./marketing-templates";

export const MARKETING_TEMPLATE_PRODUCT_ROLE = "product_image";
/** The template's product image expressed as a Generate-style reference request. */
export function marketingTemplateReferenceRequest(value: unknown): ConsumerGenerationInput {
  const input = parseConsumerMarketingTemplateInput(value);
  return {
    type: "image",
    model: "marketing_studio_v2",
    prompt: "",
    parameters: {},
    medias: input.productImage ? [{ role: MARKETING_TEMPLATE_PRODUCT_ROLE, source: input.productImage }] : [],
  };
}
/** Checked inside the job/dispatch write transaction, shared with deletion. */
export const validateConsumerMarketingTemplateSources = (tx: Pick<Transaction, "execute">, value: unknown) =>
  validateConsumerGenerationSources(tx, marketingTemplateReferenceRequest(value));
export async function resolveConsumerMarketingTemplateSource(value: unknown): Promise<{ url: string; type: "image" } | null> {
  const [source] = await resolveConsumerGenerationSources(marketingTemplateReferenceRequest(value));
  return source ? { url: source.url, type: "image" } : null;
}
/** One import claim per quote; success is reused, an unconfirmed attempt never repeats. */
export const resolveConsumerMarketingTemplateImport = (
  input: { userId: string; draftId: string; quoteKey: string; request: unknown; workspaceId: string; connectionGeneration: string },
  perform: () => Promise<string>,
) =>
  resolveConsumerGenerationImport(
    { ...input, sourceIndex: 0, request: marketingTemplateReferenceRequest(input.request) },
    perform,
  );
