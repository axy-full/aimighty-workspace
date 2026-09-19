import type { Readable } from "node:stream";
import type { ByteRange } from "../mediaRange";

/**
 * The seam between lib/storage.ts and whichever object store holds private
 * media. Every cloud call goes through one of these; lib/storage.ts keeps the
 * keys, the route URLs it hands back, the range assertions and the local-disk
 * layout, and never names an SDK.
 *
 * This module holds only types and the one shared error so the backends can
 * import it without a cycle through the selector in ./backend.
 */

export type StorageBackendKind = "blob" | "r2" | "local";

export type StorageBody = Buffer | AsyncIterable<Buffer | Uint8Array> | Readable;

export type StoragePutOptions = {
  contentType: string;
  /** false: the write must fail with ObjectExistsError when the key exists. */
  overwrite: boolean;
  /** Stream the body as parts; the backend decides how (the caller's memory stays flat). */
  multipart?: boolean;
  signal?: AbortSignal;
};

export type StorageGetOptions = {
  range?: ByteRange;
  signal?: AbortSignal;
  /** Ask for the stored bytes untransformed (Accept-Encoding: identity). Range reads always do. */
  identity?: true;
};

export type StorageGetResult = {
  stream: ReadableStream<Uint8Array>;
  headers: Headers;
  statusCode: number;
};

export type StorageListItem = {
  key: string;
  size: number;
  uploadedAt: Date;
  etag?: string;
  url?: string;
};

export type StorageListResult = {
  items: StorageListItem[];
  cursor?: string;
  hasMore: boolean;
};

export type StoragePresignOptions = {
  contentDisposition?: string;
  contentType?: string;
};

export interface StorageBackend {
  readonly kind: StorageBackendKind;
  put(key: string, body: StorageBody, options: StoragePutOptions): Promise<void>;
  /** null when the object does not exist. Range and encoding are forwarded, never asserted here. */
  get(keyOrUrl: string, options?: StorageGetOptions): Promise<StorageGetResult | null>;
  head(key: string): Promise<{ size: number } | null>;
  del(keys: string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<StorageListResult>;
  presignGet(key: string, validUntilMs: number, options?: StoragePresignOptions): Promise<string>;
}

/** A conditional write found the key already present. The object was not touched. */
export class ObjectExistsError extends Error {
  readonly code = "OBJECT_EXISTS";
  constructor(key: string, options?: { cause?: unknown }) {
    super(`Object already exists: ${key}`, options);
    this.name = "ObjectExistsError";
  }
}

export const isObjectExistsError = (error: unknown): error is ObjectExistsError =>
  error instanceof ObjectExistsError ||
  (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "OBJECT_EXISTS");

/**
 * A precondition failure is a certain outcome (nothing was written), so it
 * must not leave the recovery fence holding an uncertain activity, which
 * would block the next checkpoint for a routine "already stored" retry.
 * Every other error keeps the wrappers' uncertainOnError: true.
 */
export const uncertainUnlessExists = (error: unknown): boolean => !isObjectExistsError(error);
