import { readFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE, isFixtureUrl, type FixtureName } from "./mock";

/** The server half of the mocks: fixture bytes from public/fixtures. */
export async function fixtureBytes(name: FixtureName): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "public", "fixtures", name));
}

/** Bytes from a vendor's URL — or from a fixture, when that is what the vendor "sent". */
export async function fetchBytes(url: string, timeoutMs = 60_000): Promise<Buffer> {
  if (isFixtureUrl(url)) return fixtureBytes(url.slice(FIXTURE.length) as FixtureName);
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Could not fetch the file (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
