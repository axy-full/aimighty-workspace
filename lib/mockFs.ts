import { readFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE, isFixtureUrl, type FixtureName } from "./mock";
import { readBodyCapped } from "./boundedBody";

/** The server half of the mocks: fixture bytes from public/fixtures. */
export async function fixtureBytes(name: FixtureName): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "public", "fixtures", name));
}

/** The default ceiling for a vendor file read whole: stills and other small
 *  outputs. A caller that expects more passes its own; video goes through the
 *  streaming store (storeVideo in lib/storage.ts), never through here. */
export const FETCH_BYTES_DEFAULT_MAX = 100 * 1024 * 1024;

/** Bytes from a vendor's URL — or from a fixture, when that is what the vendor "sent". */
export async function fetchBytes(url: string, timeoutMs = 60_000, maxBytes = FETCH_BYTES_DEFAULT_MAX): Promise<Buffer> {
  if (isFixtureUrl(url)) return fixtureBytes(url.slice(FIXTURE.length) as FixtureName);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid file limit.");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`Could not fetch the file (${res.status}).`); }
  if (!res.body) throw new Error("The provider returned an empty file.");
  return readBodyCapped(res, maxBytes, "The provider file exceeds the download limit.");
}
