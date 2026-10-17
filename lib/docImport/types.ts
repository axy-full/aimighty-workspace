import { MAX_TEXT_CHARS, MAX_WARNINGS } from "./limits";

/** The source formats the importer reads. `image` is .jpg/.jpeg/.png/.tif/.tiff through OCR. */
export type DocKind = "docx" | "pdf" | "fdx" | "pptx" | "xlsx" | "image" | "svg";

/** A part of the text: a PDF page, a slide, a sheet, a scene, or the whole document. */
export type DocSection = {
  kind: "page" | "slide" | "sheet" | "scene" | "document" | "image";
  /** 1-based, in reading order. */
  index: number;
  title?: string;
  /** Offsets into `text`, end exclusive. */
  start: number;
  end: number;
};

/** An embedded picture as the extractor found it. Its type comes from its bytes, never its name. */
export type ExtractedImage = { name: string; mime: string; ext: string; bytes: Buffer };

/** What an extractor returns: pure data, nothing stored yet. */
export type ExtractedDocument = {
  kind: DocKind;
  /** `fountain` for Final Draft sources (the internal script format), `plain` otherwise. */
  format: "plain" | "fountain";
  text: string;
  sections: DocSection[];
  images: ExtractedImage[];
  warnings: string[];
};

/** A stored embedded picture: its path is always under the workspace's own prefix. */
export type StoredImage = { name: string; mime: string; path: string; bytes: number };

/** The one normalized output of an import, after its images are stored. */
export type ImportedDocument = Omit<ExtractedDocument, "images"> & {
  images: StoredImage[];
  sha256: string;
};

export type DocImportErrorCode =
  | "disabled"
  | "unsupported"
  | "type_mismatch"
  | "too_large"
  | "limit"
  | "damaged"
  | "unsafe"
  | "encrypted"
  | "timeout"
  | "language_unavailable";

/** A refusal the person can act on. The message is plain words; nothing was imported. */
export class DocImportError extends Error {
  constructor(readonly code: DocImportErrorCode, message: string) {
    super(message);
    this.name = "DocImportError";
  }
}

/** Warnings, capped: past the cap one closing line says how many more there were. */
export class Warnings {
  private readonly items: string[] = [];
  private extra = 0;
  private readonly seen = new Set<string>();
  add(message: string) {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    if (this.items.length < MAX_WARNINGS) this.items.push(message);
    else this.extra++;
  }
  list(): string[] {
    return this.extra ? [...this.items, `${this.extra} more warnings were not listed.`] : [...this.items];
  }
}

/**
 * A cooperative deadline. Parsers call check() between pages, slides,
 * sheets and XML parts; it throws once time is up or the caller aborted.
 */
export class Deadline {
  readonly at: number;
  constructor(timeoutMs: number, private readonly signal?: AbortSignal, private readonly clock: () => number = Date.now) {
    this.at = clock() + timeoutMs;
  }
  expired(): boolean {
    return this.clock() >= this.at || Boolean(this.signal?.aborted);
  }
  check() {
    if (this.expired())
      throw new DocImportError("timeout", "Reading this file took too long. Nothing was imported.");
  }
  remainingMs(): number {
    return Math.max(0, this.at - this.clock());
  }
}

/**
 * A running count of the text an import has produced, so the character
 * limit refuses the moment it is passed, before the text is ever joined.
 */
export class TextBudget {
  private used = 0;
  constructor(private readonly label: string, private readonly max = MAX_TEXT_CHARS) {}
  add(characters: number) {
    this.used += characters;
    if (this.used > this.max)
      throw new DocImportError("limit", `${this.label} has more than one million characters of text. Nothing was imported.`);
  }
}
