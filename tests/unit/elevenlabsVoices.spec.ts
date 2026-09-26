import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listVoices } from "../../lib/elevenlabs";

/**
 * The voice list is paged by ElevenLabs (100 a page). Every picker reads it,
 * so an account's own voices on page two must still be listed — and first.
 * The network is stubbed; nothing is spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-eleven-voices-"));
process.env.PLATFORM_DATABASE_URL ??= "file:" + path.join(dir, "platform.db");

const voice = (id: string, name: string, category = "premade") => ({ voice_id: id, name, category, labels: {}, preview_url: null, description: "" });

async function listed(page: (token: string | null) => unknown, force = true) {
  const saved = { key: process.env.ELEVENLABS_API_KEY, mock: process.env.ENGINE_MOCK };
  const real = globalThis.fetch, urls: string[] = [];
  process.env.ELEVENLABS_API_KEY = "eleven-unit";
  delete process.env.ENGINE_MOCK;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    urls.push(url.pathname + url.search);
    const body = page(url.searchParams.get("next_page_token"));
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  try {
    return { voices: await listVoices(force), urls };
  } finally {
    globalThis.fetch = real;
    if (saved.key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saved.key;
    if (saved.mock !== undefined) process.env.ENGINE_MOCK = saved.mock;
  }
}

test("every page of voices is read, own voices first, a voice on two pages listed once", async () => {
  const out = await listed((token) =>
    !token
      ? { voices: [voice("premadeAAA", "Aria"), voice("premadeBBB", "Brian")], has_more: true, next_page_token: "page-2" }
      : { voices: [voice("premadeBBB", "Brian"), voice("clonedCCC", "Zoe", "cloned")], has_more: false, next_page_token: null });
  expect(out.urls).toEqual(["/v2/voices?page_size=100", "/v2/voices?page_size=100&next_page_token=page-2"]);
  expect(out.voices.map((v) => v.id)).toEqual(["clonedCCC", "premadeAAA", "premadeBBB"]);
});

test("the listing is bounded: an account that never stops paging is read ten pages deep", async () => {
  let n = 0;
  const out = await listed(() => ({ voices: [voice(`voice${String(++n).padStart(4, "0")}`, `Voice ${n}`)], has_more: true, next_page_token: `page-${n + 1}` }));
  expect(out.urls).toHaveLength(10);
  expect(out.voices).toHaveLength(10);
});

/* A later page that fails keeps what was read: the picker still lists those voices, and
   the list is asked for again in a minute rather than ten. */
test("a later page that fails keeps the pages already read, without falling back to the old list", async () => {
  const out = await listed((token) =>
    !token
      ? { voices: [voice("premadeAAA", "Aria")], has_more: true, next_page_token: "page-2" }
      : new Response("busy", { status: 500 }));
  expect(out.urls).toEqual(["/v2/voices?page_size=100", "/v2/voices?page_size=100&next_page_token=page-2"]);
  expect(out.voices.map((v) => v.id)).toEqual(["premadeAAA"]);
  const memo = await listed(() => new Response("never asked", { status: 500 }), false);
  expect(memo).toEqual({ voices: out.voices, urls: [] });
});

test("every page together gets the time one listing had: a slow account stops paging, keeping what it read", async () => {
  const realNow = Date.now;
  let clock = realNow(), n = 0;
  Date.now = () => clock;
  try {
    const out = await listed(() => {
      clock += 15_000;
      n++;
      return { voices: [voice(`voice${n}`, `Voice ${n}`)], has_more: true, next_page_token: `page-${n + 1}` };
    });
    expect(out.urls).toHaveLength(2);
    expect(out.voices.map((v) => v.id)).toEqual(["voice1", "voice2"]);
  } finally {
    Date.now = realNow;
  }
});
