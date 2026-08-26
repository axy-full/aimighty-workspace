import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireUser } from "@/lib/auth";
import { IMAGE_LIMITS } from "@/lib/imagemeta";

export const dynamic = "force-dynamic";

const ALLOWED = [
  "image/jpeg", "image/png", "image/webp", "image/bmp",
  "image/tiff", "image/gif", "image/heic", "image/heif",
];

/**
 * Issues a short-lived token so the BROWSER can upload a >4MB image straight
 * to Blob storage — Vercel caps an inbound request body at 4.5MB, which a
 * normal camera photo blows past. Smaller files go through /api/uploads.
 *
 * Client-token uploads only support PUBLIC objects, so these blobs rely on
 * addRandomSuffix (crypto-random, unguessable URL) and are only ever served
 * through the authed proxy. The file still travels untouched: this route
 * never sees the bytes, and /api/uploads/register re-reads and hashes what
 * actually landed.
 */
export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;

  const body = (await req.json()) as HandleUploadBody;

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED,
        maximumSizeInBytes: IMAGE_LIMITS.maxBytes,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ userId: got.user.id }),
      }),
      // Fires only on a public URL; we register explicitly from the client
      // instead so this works identically in local development.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
