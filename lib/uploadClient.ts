"use client";

/**
 * One uploader for the whole app — references and chat attachments alike.
 * ≤4MB posts whole; bigger files slice into ~3.5MB chunks (under Vercel's
 * 4.5MB request cap), three in flight at a time, then a finish call
 * reassembles them server-side. Bytes are never transformed anywhere.
 */

const CHUNK = 3_500_000;
const PARALLEL = 3;

export type UploadedFile = {
  id: string; filename: string; mime: string; kind: "image" | "video" | "file";
  bytes: number; width: number | null; height: number | null;
  durationS: number | null; sha256: string; url: string; base64Bytes?: number;
};

export async function sha256OfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadFile(
  file: File,
  purpose: "reference" | "chat",
  onProgress?: (pct: number) => void
): Promise<UploadedFile> {
  if (purpose === "chat" && file.size > 2 * 1024 * 1024 * 1024) {
    throw new Error("Chat files top out at 2 GB.");
  }

  if (file.size <= 4 * 1024 * 1024 && purpose === "reference") {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body: fd });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Upload failed");
    onProgress?.(100);
    return json;
  }

  const session = crypto.randomUUID();
  const count = Math.max(1, Math.ceil(file.size / CHUNK));
  let done = 0;

  async function sendChunk(i: number, attempt = 0): Promise<void> {
    const fd = new FormData();
    fd.append("session", session);
    fd.append("index", String(i));
    fd.append("chunk", file.slice(i * CHUNK, (i + 1) * CHUNK));
    const res = await fetch("/api/uploads/chunk", { method: "POST", body: fd });
    if (!res.ok) {
      if (attempt < 1) return sendChunk(i, attempt + 1); // one retry per slice
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? `Chunk ${i + 1}/${count} failed`);
    }
    done++;
    onProgress?.(Math.round((done / count) * 95));
  }

  // Three slices in flight keeps the pipe full without hammering the server.
  let next = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, count) }, async () => {
    while (next < count) {
      const i = next++;
      await sendChunk(i);
    }
  });
  await Promise.all(workers);

  const res = await fetch("/api/uploads/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, count, filename: file.name, purpose, mime: file.type || undefined }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Upload failed");
  onProgress?.(100);
  return json;
}
