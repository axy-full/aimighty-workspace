/**
 * The one project video a Shorts Studio session restyles: validated, resolved
 * and imported exactly like a Generate reference (same tables, claims and
 * limits). The stored duration — never a browser value — prices the session.
 */
import type { Transaction } from "@libsql/client";
import { db, ready } from "@/lib/db";
import { describeConsumerGenerationSources, resolveConsumerGenerationImport, resolveConsumerGenerationSources, validateConsumerGenerationSources } from "./generation-sources";
import { shortsReferenceRequest } from "./shorts-studio";

/** Checked inside the job/dispatch write transaction, shared with deletion. */
export const validateConsumerShortsSources = (tx: Pick<Transaction, "execute">, value: unknown) =>
  validateConsumerGenerationSources(tx, shortsReferenceRequest(value));
export async function describeConsumerShortsSource(value: unknown) {
  const [source] = await describeConsumerGenerationSources(shortsReferenceRequest(value));
  return { kind: source.kind, name: source.name };
}
export async function resolveConsumerShortsSource(value: unknown): Promise<{ url: string; type: "video"; durationSeconds?: number }> {
  const request = shortsReferenceRequest(value);
  await ready();
  const [validated] = await validateConsumerGenerationSources(db(), request);
  const [source] = await resolveConsumerGenerationSources(request);
  return { url: source.url, type: "video", ...(validated.durationS === null ? {} : { durationSeconds: validated.durationS }) };
}
/** One import claim per quote; success is reused, an unconfirmed attempt never repeats. */
export const resolveConsumerShortsImport = (
  input: { userId: string; draftId: string; quoteKey: string; request: unknown; workspaceId: string; connectionGeneration: string },
  perform: () => Promise<string>,
) => resolveConsumerGenerationImport({ ...input, sourceIndex: 0, request: shortsReferenceRequest(input.request) }, perform);
