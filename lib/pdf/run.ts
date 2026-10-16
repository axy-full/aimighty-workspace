import { randomUUID } from "node:crypto";
import { db, id as newId } from "../db";
import { requireTenant } from "../tenant";
import { storeUpload } from "../storage";
import { reachableOr } from "../draftProject";
import { getTreatment } from "../atomikDocs";
import { readDraft } from "../workbench/records";
import { EVENTS } from "../dispatch";
import { acquireSlot, releaseSlot } from "../worker-slots";
import { ExportWorkerBusyError, ExportWorkerRefusedError, ExportWorkerError, openExportSession, type ExportWorkerDeps } from "../exports/worker";
import { nameStem } from "../v12/deliver";
import { PDF_COMPOSITION, PDF_HTML_FILE, PDF_OUTPUT_FILE, checkDeckHtml, pdfFacts, type PdfSpec } from "../../remotion/src/lib/pdf";
import { DeckTooLong, ppmDoc, pitchDoc, treatmentDoc, type BuildOptions } from "./builders";
import { PdfError, NOTHING_BILLED, type DeckPdf, type DeckRequest } from "./contract";
import { DEFAULT_PAGE, PAGE_SIZES, type DeckDoc } from "./deck";
import { deckHtml } from "./html";
import { bindPictures, workspacePictures, type PictureSource, type Viewer } from "./images";

/**
 * Make a deck PDF: load what the request names inside the caller's own workspace, write the deck as one page of our own HTML, send the
 * page and its pictures to an export worker, have the worker's fixed command print it, check what came back, and keep it under this
 * workspace's own storage prefix as an upload only the caller (and shared work) can open. Free: no credits move at any point.
 */
export type PdfDeps = ExportWorkerDeps & {
  pictures?: PictureSource;
  /** "15 Oct 2026". */
  now?: () => Date;
  runTimeoutMs?: number;
  /** Replaces the worker slot (tests). */
  slot?: { acquire: typeof acquireSlot; release: typeof releaseSlot };
};

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

async function source(request: DeckRequest, viewer: Viewer, build: BuildOptions): Promise<DeckDoc> {
  if (request.kind === "treatment") {
    if (!request.projectId) throw new PdfError("A treatment needs the production it belongs to (projectId).");
    /* A private board is its owner's and a shared one a teammate's to read; to anyone else it is a production that does not exist. */
    const projectId = await reachableOr(viewer, request.projectId, "read");
    const treatment = projectId === request.projectId ? await getTreatment(projectId) : null;
    if (!treatment) throw new PdfError("That production has no treatment to print yet.", 404);
    return treatmentDoc({ title: treatment.title, logline: treatment.logline, setup: treatment.setup, scenes: treatment.scenes, draft: treatment.draft }, build);
  }
  if (request.kind === "ppm") {
    if (!request.board) throw new PdfError("A PPM deck needs the board it is made from (board).");
    const draft = await readDraft(viewer.id, request.board);
    if (!draft) throw new PdfError("That board isn't available in this workspace.", 404);
    return ppmDoc(draft.project, build);
  }
  if (!request.pitch) throw new PdfError("A pitch deck needs its words (pitch: a logline, an audience and sections).");
  return pitchDoc({ title: request.title ?? "", logline: request.pitch.logline, audience: request.pitch.audience, sections: request.pitch.sections }, build);
}

/** What a failed print says to the customer: never a path, a host or the browser's own words. */
const REFUSALS: Record<number, string> = {
  2: "The deck page was refused before it was printed.",
  3: "A picture for the deck was missing or was not what it said.",
  4: "The deck could not be printed.",
};

export async function makeDeckPdf(request: DeckRequest, viewer: Viewer, deps: PdfDeps = {}): Promise<DeckPdf> {
  const tenant = requireTenant();
  const date = DATE.format((deps.now ?? (() => new Date()))());
  const bound = await bindPictures(request, viewer, deps.pictures ?? workspacePictures);
  const size = request.page ?? DEFAULT_PAGE[request.kind];
  let doc: DeckDoc;
  try {
    doc = await source(request, viewer, { size, bleedMm: request.bleedMm ?? 0, title: request.title, logo: bound.logo, pictures: bound.pictures, date });
  } catch (error) {
    if (error instanceof DeckTooLong) throw new PdfError(error.message, 413);
    throw error;
  }
  /* The pictures the pages actually use: a logo or a picture that no page shows is not sent. */
  const sent = bound.files.filter((file) => doc.images.includes(file.name));
  const html = deckHtml(doc);
  const problems = checkDeckHtml(html, sent.map((file) => file.name));
  if (problems.length) throw new PdfError("The deck page could not be written safely.", 500);
  const spec: PdfSpec = { version: 1, composition: PDF_COMPOSITION, pdf: { pages: doc.pages.length, trimMm: PAGE_SIZES[doc.size], bleedMm: doc.bleedMm, images: sent.map((file) => file.name) } };

  const jobId = `pdf-${randomUUID()}`;
  const slots = deps.slot ?? { acquire: acquireSlot, release: releaseSlot };
  const slot = await slots.acquire({ kind: EVENTS.exportRender, workspaceId: tenant.id, jobId, ttlMs: 330_000 });
  if (!slot) throw new PdfError("Every export worker is busy. Try again in a minute.", 429, 30);
  let session: Awaited<ReturnType<typeof openExportSession>> | null = null;
  try {
    try {
      session = await openExportSession(`remotion-export-${randomUUID()}`, deps);
    } catch (error) {
      if (error instanceof ExportWorkerBusyError) throw new PdfError("Every export worker is busy. Try again in a minute.", 429, 30);
      if (error instanceof ExportWorkerRefusedError) throw new PdfError("Deck PDFs are not set up on this deployment.", 503);
      throw new PdfError(`The PDF could not be made. ${NOTHING_BILLED}`, 502);
    }
    try {
      await session.putFile("spec.json", JSON.stringify(spec));
      await session.putFile(`input/${PDF_HTML_FILE}`, html);
      for (const file of sent) await session.putFile(`input/${file.name}`, file.bytes);
      const reply = await session.run(deps.runTimeoutMs ?? 150_000);
      if (reply.exitCode !== 0 || reply.timedOut) throw new PdfError(`${REFUSALS[reply.exitCode] ?? REFUSALS[4]} ${NOTHING_BILLED}`, 502);
      const pdf = await session.readOutput(PDF_OUTPUT_FILE);
      const facts = pdf ? pdfFacts(pdf) : null;
      if (!pdf || !facts?.header || facts.pages !== doc.pages.length) throw new PdfError(`The PDF could not be made. ${NOTHING_BILLED}`, 502);
      return await save(doc, pdf, viewer);
    } catch (error) {
      if (error instanceof PdfError) throw error;
      if (error instanceof ExportWorkerError) throw new PdfError(`The PDF could not be made. ${NOTHING_BILLED}`, 502);
      throw error;
    }
  } finally {
    await session?.stop().catch(() => {});
    await slots.release(slot.id).catch(() => {});
  }
}

async function save(doc: DeckDoc, pdf: Buffer, viewer: Viewer): Promise<DeckPdf> {
  const uploadId = newId("pdf");
  const stored = await storeUpload(uploadId, "pdf", pdf, "application/pdf");
  const filename = `${nameStem(doc.title)}_${doc.kind}.pdf`;
  await db().execute({
    sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at,uploader_id) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,NULL,?,?)`,
    args: [uploadId, filename, "application/pdf", "pdf", pdf.length, stored.sha256, stored.url, "document", Date.now(), viewer.id],
  });
  return { uploadId, url: `/api/uploads/${uploadId}`, filename, mime: "application/pdf", bytes: pdf.length, pages: doc.pages.length, kind: doc.kind, price: { credits: 0, label: "Free" } };
}
