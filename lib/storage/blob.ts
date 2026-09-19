import { Readable } from "node:stream";
import { withRecoveryActivity } from "../recovery";
import {
  ObjectExistsError,
  uncertainUnlessExists,
  type StorageBackend,
  type StorageBody,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListResult,
  type StoragePresignOptions,
  type StoragePutOptions,
} from "./types";

/**
 * Vercel Blob, exactly as lib/storage.ts called it before the seam existed:
 * private access, no random suffix, the SDK loaded lazily so a local run never
 * touches it, every put and delete inside a "blob-put"/"blob-delete" recovery
 * activity that is uncertain on error. Nothing here decides keys or asserts
 * ranges; that stays with the caller.
 */

type BlobSdk = typeof import("@vercel/blob");

const PUBLIC_HOST = ".public.blob.vercel-storage.com/";

const sdk = (): Promise<BlobSdk> => import("@vercel/blob");

/** The SDK's "already exists" failure, whichever class or message the store returns it as. */
function alreadyExists(error: unknown, blob: BlobSdk): boolean {
  const Precondition = (blob as Partial<BlobSdk>).BlobPreconditionFailedError;
  if (typeof Precondition === "function" && error instanceof Precondition) return true;
  const message = error instanceof Error ? error.message : "";
  return /already exists/i.test(message);
}

function notFound(error: unknown, blob: BlobSdk): boolean {
  const NotFound = (blob as Partial<BlobSdk>).BlobNotFoundError;
  if (typeof NotFound === "function" && error instanceof NotFound) return true;
  const message = error instanceof Error ? error.message : "";
  return /does not exist|not found/i.test(message);
}

export function createBlobBackend(): StorageBackend {
  return {
    kind: "blob",

    async put(key: string, body: StorageBody, options: StoragePutOptions): Promise<void> {
      const blob = await sdk();
      const payload = Buffer.isBuffer(body) || body instanceof Readable ? body : Readable.from(body);
      await withRecoveryActivity("blob-put", async () => {
        try {
          await blob.put(key, payload, {
            access: "private",
            contentType: options.contentType,
            addRandomSuffix: false,
            allowOverwrite: options.overwrite,
            ...(options.multipart ? { multipart: true } : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          });
        } catch (error) {
          if (!options.overwrite && alreadyExists(error, blob)) throw new ObjectExistsError(key, { cause: error });
          throw error;
        }
      }, { uncertainOnError: uncertainUnlessExists });
    },

    async get(keyOrUrl: string, options: StorageGetOptions = {}): Promise<StorageGetResult | null> {
      const blob = await sdk();
      const { range, signal, identity } = options;
      const headers = range || identity
        ? { "Accept-Encoding": "identity", ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }
        : null;
      const found = await blob.get(keyOrUrl, {
        access: keyOrUrl.includes(PUBLIC_HOST) ? "public" : "private",
        ...(signal ? { abortSignal: signal } : {}),
        ...(headers ? { headers } : {}),
      });
      if (!found?.stream) return null;
      return {
        stream: found.stream as ReadableStream<Uint8Array>,
        headers: (found.headers ?? new Headers()) as Headers,
        statusCode: found.statusCode ?? 200,
      };
    },

    async head(key: string): Promise<{ size: number } | null> {
      const blob = await sdk();
      try {
        const result = await blob.head(key);
        return result ? { size: result.size } : null;
      } catch (error) {
        if (notFound(error, blob)) return null;
        throw error;
      }
    },

    async del(keys: string[]): Promise<void> {
      if (!keys.length) return;
      const blob = await sdk();
      await withRecoveryActivity("blob-delete", () => blob.del(keys), { uncertainOnError: true });
    },

    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<StorageListResult> {
      const blob = await sdk();
      const result = await blob.list({
        ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      return {
        items: result.blobs.map((item) => ({ key: item.pathname, size: item.size, uploadedAt: item.uploadedAt, url: item.url })),
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        hasMore: result.hasMore,
      };
    },

    /* The response-content-* options are an S3 feature; Blob's presigned GET
       has no equivalent, so a download through Blob keeps streaming through
       the route as it does today. */
    async presignGet(key: string, validUntilMs: number, _options: StoragePresignOptions = {}): Promise<string> {
      void _options;
      const { issueSignedToken, presignUrl } = await sdk();
      const token = await issueSignedToken({ pathname: key, operations: ["get"], validUntil: validUntilMs });
      const { presignedUrl } = await presignUrl(token, {
        operation: "get", pathname: key, access: "private", validUntil: validUntilMs,
      });
      return presignedUrl;
    },
  };
}
