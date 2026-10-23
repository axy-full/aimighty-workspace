import { createHash } from "node:crypto";
import { inngest, inngestConfigured } from "../inngest";
import { getWorkspace } from "../platform";
import { readImportBytes, storeImportBytes } from "../storage";
import { requireTenant, runInTenant, type TenantWorkspace } from "../tenant";
import { extensionOf } from "./detect";
import { docImportEnabled } from "./flag";
import { MAX_SOURCE_BYTES } from "./limits";
import { OCR_LANGUAGES, type OcrLanguage } from "./image";
import { DocImportError, type ExtractedDocument, type ImportedDocument, type StoredImage } from "./types";

/**
 * The import pipeline's background step (v30 Phase A item 2, part 1), on
 * Inngest, behind DOC_IMPORT_ENABLED (off by default).
 *
 * An event carries identifiers only: the workspace, a generated import id,
 * the source's extension and the OCR languages. Never a file name, never
 * document text, never a path: the function derives every storage key itself
 * under ws/<workspace>/imports/<import id>/ (lib/storage.ts), so an event
 * cannot point it at another workspace's objects. Its step returns counts
 * only, so no document text is kept in Inngest's step history either.
 *
 * It reads the stored source, extracts it (lib/docImport/extract.ts: pure,
 * no model call, nothing billed), stores each embedded picture and then the
 * one normalized result as result.json. A refusal is stored as result.json
 * too, with its code and plain message, and is not retried: the same bytes
 * would be refused the same way.
 *
 * Not here, on purpose: reading a document for understanding (an LLM pass)
 * is a billed job and waits for the jobs and money work.
 */

export const DOC_IMPORT_REQUESTED = "documents/import.requested";

export type DocImportEventData = {
  workspaceId: string;
  importId: string;
  /** The source's extension, lower case, as stored: source.<extension>. */
  extension: string;
  /** OCR languages joined with "+", for pictures. Defaults to "eng". */
  languages?: string;
};

export type DocImportOutcome =
  | { importId: string; skipped: "disabled" }
  | { importId: string; ok: true; kind: ExtractedDocument["kind"]; characters: number; sections: number; images: number; warnings: number }
  | { importId: string; failed: DocImportError["code"] };

const IMPORT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const EXTENSION = /^[a-z0-9]{1,5}$/;

function parseLanguages(raw: string | undefined): OcrLanguage[] {
  const codes = (raw || "eng").split("+");
  if (codes.length > OCR_LANGUAGES.length || codes.some((code) => !OCR_LANGUAGES.includes(code as OcrLanguage)))
    throw new Error("Invalid document import event.");
  return codes as OcrLanguage[];
}

export function validateDocImportEvent(data: DocImportEventData): OcrLanguage[] {
  if (!data.workspaceId || !/^[A-Za-z0-9_-]{1,80}$/.test(data.workspaceId) || !IMPORT_ID.test(data.importId) || !EXTENSION.test(data.extension))
    throw new Error("Invalid document import event.");
  return parseLanguages(data.languages);
}

export function docImportEventOf(raw: Record<string, unknown>): DocImportEventData {
  return {
    workspaceId: String(raw.workspaceId ?? ""),
    importId: String(raw.importId ?? ""),
    extension: String(raw.extension ?? ""),
    ...(raw.languages ? { languages: String(raw.languages) } : {}),
  };
}

export type DocImportDeps = {
  enabled?: () => boolean;
  workspaceOf?: (id: string) => Promise<TenantWorkspace | null>;
  read?: typeof readImportBytes;
  store?: typeof storeImportBytes;
  extract?: (filename: string, bytes: Buffer, options: { languages: OcrLanguage[] }) => Promise<ExtractedDocument>;
};

const LARGEST_SOURCE = Math.max(...Object.values(MAX_SOURCE_BYTES));

export async function runDocumentImport(data: DocImportEventData, deps: DocImportDeps = {}): Promise<DocImportOutcome> {
  if (!(deps.enabled ?? docImportEnabled)()) return { importId: String(data.importId ?? ""), skipped: "disabled" };
  const languages = validateDocImportEvent(data);
  // The event's workspace, and only it: no fallback to any other.
  const workspace = await (deps.workspaceOf ?? getWorkspace)(data.workspaceId);
  if (!workspace || workspace.id !== data.workspaceId || workspace.deletedAt || workspace.suspendedAt)
    throw new Error("The workspace is unavailable for document import.");
  const read = deps.read ?? readImportBytes;
  const store = deps.store ?? storeImportBytes;
  const extract = deps.extract ?? (async (filename, bytes, options) => (await import("./extract")).extractDocument(filename, bytes, options));
  return runInTenant(workspace, async () => {
    const { importId, extension } = data;
    const saveResult = (value: unknown) => store(importId, "result.json", Buffer.from(JSON.stringify(value)), "application/json");
    try {
      // One byte past the largest limit is enough for the extractor to refuse it as too large.
      const source = await read(importId, `source.${extension}`, LARGEST_SOURCE + 1).catch((error: unknown) => {
        if (error instanceof Error && /larger than/.test(error.message))
          throw new DocImportError("too_large", "This file is larger than the importer reads. Nothing was imported.");
        throw error;
      });
      const extracted = await extract(`source.${extension}`, source, { languages });
      const images: StoredImage[] = [];
      for (const [n, image] of extracted.images.entries()) {
        const path = await store(importId, `images/${n + 1}.${image.ext}`, image.bytes, image.mime);
        images.push({ name: image.name.replace(/[\u0000-\u001f\u007f]/g, ""), mime: image.mime, path, bytes: image.bytes.length });
      }
      const result: ImportedDocument = {
        kind: extracted.kind,
        format: extracted.format,
        text: extracted.text,
        sections: extracted.sections,
        images,
        warnings: extracted.warnings,
        sha256: createHash("sha256").update(source).digest("hex"),
      };
      await saveResult({ ok: true, document: result });
      return {
        importId,
        ok: true,
        kind: result.kind,
        characters: result.text.length,
        sections: result.sections.length,
        images: images.length,
        warnings: result.warnings.length,
      };
    } catch (error) {
      if (!(error instanceof DocImportError)) throw error;
      await saveResult({ ok: false, error: { code: error.code, message: error.message } });
      return { importId, failed: error.code };
    }
  });
}

/**
 * Queue an import of a source already stored at source.<extension> for the
 * workspace in scope. Off, or with no Inngest on this deployment, it sends
 * nothing and says why.
 */
export async function enqueueDocumentImport(
  input: { importId: string; extension: string; languages?: OcrLanguage[] },
  deps: { enabled?: () => boolean; configured?: () => boolean; send?: (event: { id: string; name: string; data: DocImportEventData }) => Promise<unknown> } = {},
): Promise<{ queued: true } | { queued: false; reason: "disabled" | "no_queue" }> {
  if (!(deps.enabled ?? docImportEnabled)()) return { queued: false, reason: "disabled" };
  const data: DocImportEventData = {
    workspaceId: requireTenant().id,
    importId: input.importId,
    extension: input.extension.toLowerCase(),
    ...(input.languages?.length ? { languages: input.languages.join("+") } : {}),
  };
  validateDocImportEvent(data);
  if (extensionOf(`source.${data.extension}`) !== data.extension) throw new Error("Invalid document import event.");
  if (!(deps.configured ?? inngestConfigured)()) return { queued: false, reason: "no_queue" };
  await (deps.send ?? ((event) => inngest.send(event)))({ id: `document-import-${data.importId}`, name: DOC_IMPORT_REQUESTED, data });
  return { queued: true };
}

export const docImportWorker = inngest.createFunction(
  {
    id: "document-import",
    name: "Import a document",
    triggers: [{ event: DOC_IMPORT_REQUESTED }],
    // Parsing is CPU and memory: two at once platform-wide, one per workspace.
    concurrency: [{ limit: 2 }, { limit: 1, key: "event.data.workspaceId" }],
    retries: 1,
  },
  async ({ event, step }) =>
    step.run("extract-and-store", () => runDocumentImport(docImportEventOf(event.data as Record<string, unknown>))),
);

/** What /api/inngest serves for imports: nothing at all while the switch is off. */
export function docImportFunctions(env: Record<string, string | undefined> = process.env) {
  return docImportEnabled(env) ? [docImportWorker] : [];
}
