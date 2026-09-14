import { readFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE, isFixtureUrl, type FixtureName } from "./mock";

/** The server half of the mocks: fixture bytes from public/fixtures. */
export async function fixtureBytes(name: FixtureName): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "public", "fixtures", name));
}

/** Bytes from a vendor's URL — or from a fixture, when that is what the vendor "sent". */
export async function fetchBytes(url: string, timeoutMs = 60_000, maxBytes?: number): Promise<Buffer> {
  if (isFixtureUrl(url)) return fixtureBytes(url.slice(FIXTURE.length) as FixtureName);
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Could not fetch the file (${res.status}).`);
  if (maxBytes != null) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid file limit.");
    if (Number(res.headers.get("content-length")) > maxBytes) {
      await res.body?.cancel(); throw new Error("The provider file exceeds the download limit.");
    }
    if (!res.body) throw new Error("The provider returned an empty file.");
    const reader = res.body.getReader(); const chunks: Buffer[] = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new Error("The provider file exceeds the download limit."); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } finally { reader.releaseLock(); }
  }
  return Buffer.from(await res.arrayBuffer());
}
