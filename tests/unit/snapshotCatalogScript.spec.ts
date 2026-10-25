import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import committedJson from "../../lib/modelCatalog.json";
import type { CatalogSnapshot, CatalogSnapshotEntry } from "../../lib/catalog";

/*
 * scripts/ops/snapshot-catalog.mjs --add: an added id is recorded in the snapshot's `added` list and every later run keeps it; --only-add
 * leaves every other entry as it was; and nothing is written when an added id is missing from the list, has no input or output price, or is
 * not a language model. Run on saved responses (--from) into a temporary snapshot (--out): no network, and lib/modelCatalog.json is never
 * touched. The added ids are made up.
 */
const committed = committedJson as unknown as CatalogSnapshot;
const SCRIPT = path.join(__dirname, "../../scripts/ops/snapshot-catalog.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "particl-snapshot-script-"));

/** A model list entry as the list states it, made back from a snapshot entry: a response that reproduces today's snapshot. */
const raw = (m: CatalogSnapshotEntry) => ({
  id: m.id, name: m.name, released: m.released, type: m.type, description: m.description,
  context_window: m.contextWindow ?? undefined, max_tokens: m.maxTokens ?? undefined, pricing: m.pricing,
  modalities: { input: m.inputModalities, output: m.outputModalities }, tags: m.tags,
  supported_parameters: m.supportedParameters, reasoning_options: m.reasoningOptions, temperature: m.temperature,
});
const TODAY = committed.models.map(raw);
const made = (id: string, type: string, pricing: Record<string, unknown>) => ({
  id, name: id.split("/")[1], type, description: "A made-up model for the snapshot script's tests.", context_window: 200_000, max_tokens: 32_000,
  pricing, modalities: { input: ["text"], output: ["text"] }, tags: [], supported_parameters: [], reasoning_options: [],
});
/* Prices read from an OpenAI text entry of today's snapshot, never written here. */
const PRICED = committed.models.find((m) => m.owner === "openai" && m.type === "language" && m.pricing?.input != null && m.pricing?.output != null && m.pricing?.input_cache_read != null)!.pricing as Record<string, string>;
const without = (key: string) => Object.fromEntries(Object.entries(PRICED).filter(([k]) => k !== key));
const MOVED = { ...PRICED, output: String(Number(PRICED.output) * 2) };
const ADDED = "openai/unit-added-text";

let n = 0;
function run(response: unknown[], args: string[], snapshot: unknown): { status: number; output: string; after: CatalogSnapshot & { added?: string[] }; unchanged: boolean } {
  const base = path.join(dir, `run-${++n}`);
  writeFileSync(`${base}-response.json`, JSON.stringify({ object: "list", data: response }));
  const before = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeFileSync(`${base}-snapshot.json`, before);
  let status = 0, output = "";
  try {
    output = execFileSync(process.execPath, [SCRIPT, `--from=${base}-response.json`, `--out=${base}-snapshot.json`, ...args], {
      env: { ...process.env, MODEL_CATALOG: "static", ENGINE_MOCK: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1; output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const text = readFileSync(`${base}-snapshot.json`, "utf8");
  return { status, output, after: JSON.parse(text), unchanged: text === before };
}

test.describe.configure({ mode: "serial", timeout: 240_000 });

test("--only-add appends the added id, records it in `added`, and leaves every other entry as it was", () => {
  const { status, output, after } = run([...TODAY, made(ADDED, "language", PRICED)], ["--priced-at=2026-10-30", "--only-add", `--add=${ADDED}`], committed);
  expect(status, output).toBe(0);
  const { models, added, ...rest } = after;
  const { models: beforeModels, added: beforeAdded, ...beforeRest } = committed;
  expect(rest).toEqual(beforeRest);
  expect(models.slice(0, beforeModels.length)).toEqual(beforeModels);
  expect(models.length).toBe(beforeModels.length + 1);
  expect(models.at(-1)).toMatchObject({ id: ADDED, providerId: "openai", pricedAt: "2026-10-30", type: "language", pricing: PRICED });
  expect(added).toEqual([...(beforeAdded ?? []), ADDED]);
});

test("a later refresh keeps an added id, with no --add, and still leaves out what nothing offers", () => {
  const first = run([...TODAY, made(ADDED, "language", PRICED)], ["--priced-at=2026-10-30", "--only-add", `--add=${ADDED}`], committed);
  expect(first.status, first.output).toBe(0);
  const unoffered = made("openai/unit-not-offered", "language", PRICED);
  const later = run([...TODAY, made(ADDED, "language", MOVED), unoffered], ["--priced-at=2026-11-02"], first.after);
  expect(later.status, later.output).toBe(0);
  expect(later.after.added).toEqual(first.after.added);
  const kept = later.after.models.find((m) => m.id === ADDED);
  expect(kept, "the added id is kept on a refresh").toMatchObject({ pricedAt: "2026-11-02", pricing: MOVED });
  expect(later.after.models.some((m) => m.id === unoffered.id)).toBe(false);
  expect(later.after.missing).toEqual([]);
  // Provider-priced entries are carried over as before.
  expect(later.after.providerPriced).toEqual(committed.providerPriced);

  // A refresh whose list no longer has a kept id writes nothing.
  const gone = run(TODAY, ["--priced-at=2026-11-03"], first.after);
  expect(gone.status).toBe(1);
  expect(gone.output).toContain("refusing to write");
  expect(gone.unchanged).toBe(true);
});

test("nothing is written when an added id is missing from the list, lacks an input or output price, or is not a language model", () => {
  const cases: [string, unknown[]][] = [
    ["openai/unit-not-listed", TODAY],
    ["openai/unit-no-output", [...TODAY, made("openai/unit-no-output", "language", without("output"))]],
    ["openai/unit-no-input", [...TODAY, made("openai/unit-no-input", "language", without("input"))]],
    ["openai/unit-a-video", [...TODAY, made("openai/unit-a-video", "video", PRICED)]],
  ];
  for (const [id, response] of cases) for (const mode of [["--only-add"], []]) {
    const { status, output, unchanged } = run(response, ["--priced-at=2026-10-30", ...mode, `--add=${id}`], committed);
    expect(status, `${id} ${mode.join(" ")}: ${output}`).toBe(1);
    expect(output, id).toContain("refusing to write");
    expect(unchanged, id).toBe(true);
  }
  // An argument that is not a catalogue id is refused before anything is read.
  const bad = run(TODAY, ["--priced-at=2026-10-30", "--only-add", "--add=not an id"], committed);
  expect(bad.status).toBe(1);
  expect(bad.unchanged).toBe(true);
});
