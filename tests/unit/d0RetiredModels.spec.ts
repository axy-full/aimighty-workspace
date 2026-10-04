import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODELS, RETIRED_LABELS, RETIRED_REASON, displayModelName, findModel, getModel, isOffered, isRetiredModel, modelLabel,
  offeredModels, providerOf, retiredLabel, retiredReason, shortLabel, type ModelDef,
} from "../../lib/models";
import { SOUL_FAMILY_NAMES, SOUL_RENDER_MODELS, SOUL_VERSIONS, SOUL_VERSION_LABELS, soulFamilyName, soulVersionOf } from "../../lib/soulRenderTypes";
import { engineLabel, shotEngines } from "../../lib/workspace/engines";
import { meteredLine } from "../../lib/statements";
import { IDENTITY_ASSET_KIND, REF_SOURCE_LABEL, memoryAssetKind } from "../../lib/atomikMemoryText";
import { vendorNameIn } from "../../lib/vendorNames";

/**
 * D0.2 — removals and renames. Only what needed a sign-in was removed: the
 * three identity-still families stay on the platform's key, offered through
 * Cast (owner's decision, 4 October 2026), under neutral names. The `retired`
 * mechanism stays in the registry with no model marked; ids that were only
 * ever in the connected catalogue never show raw.
 */
const SOUL_IDS = ["hf-soul-standard", "hf-soul-2", "hf-soul-cinema"];
const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("the three identity-still models are offered again, from Cast: not retired, admitted, hidden from Gen's own lists", () => {
  expect(Object.values(SOUL_RENDER_MODELS)).toEqual(SOUL_IDS);
  expect(MODELS.filter((m) => m.retired)).toEqual([]);
  for (const id of SOUL_IDS) {
    const model = getModel(id);
    expect(model).toMatchObject({ id, kind: "image", provider: "higgsfield", billing: "image", soulIdentity: true, hidden: true });
    expect(model.retired).toBeUndefined();
    expect(isOffered(model)).toBe(true);
    expect(isRetiredModel(id)).toBe(false);
    expect(retiredReason(id)).toBeNull();
    expect(findModel(id)).toBe(model);
    expect(offeredModels().some((m) => m.id === id)).toBe(true);
    /* Reached from Cast, as before: `hidden` keeps them out of a shot's engines and the palette. */
    expect(shotEngines().some((m) => m.id === id)).toBe(false);
  }
  /* The stored ids and versions are untouched: an identity's `model_version` still maps to its own model. */
  expect([...SOUL_VERSIONS]).toEqual(["v1", "v2", "cinema"]);
  expect(SOUL_IDS.map(soulVersionOf)).toEqual(["v1", "v2", "cinema"]);
  /* Cast's select and "Renders with" drop the prefix: one list, two forms. */
  expect(SOUL_FAMILY_NAMES).toEqual({ v1: "Standard", v2: "2", cinema: "Cinema" });
  expect(SOUL_IDS.map(soulFamilyName)).toEqual(["Standard", "2", "Cinema"]);
  for (const v of SOUL_VERSIONS) expect(SOUL_VERSION_LABELS[v]).toBe(`Identity still · ${SOUL_FAMILY_NAMES[v]}`);
  expect(soulFamilyName("gpt-image-2")).toBeNull();
  expect(soulFamilyName(null)).toBeNull();
});

test("the retirement mechanism still works for a model that carries the flag", () => {
  const live = getModel(SOUL_IDS[0]);
  const gone: ModelDef = { ...live, id: "synthetic-retired", retired: true };
  expect(isOffered(gone)).toBe(false);
  expect(isOffered(live)).toBe(true);
  expect(offeredModels([live, gone])).toEqual([live]);
  expect(shotEngines([{ ...gone, hidden: false }])).toEqual([]);
  expect(RETIRED_REASON).toBe("This engine is no longer offered for new renders. Past results stay in the Library.");
  expect(vendorNameIn(RETIRED_REASON)).toBeNull();
  /* Admission still asks, for a quote and a submit alike, before anything is resolved or priced. */
  const admission = source("lib/generationAdmission.ts");
  expect(admission).toMatch(/const retired = retiredReason\(modelId\);\s+if \(retired\) return admissionReply\(\{ error: retired, code: "engine_retired" \}, \{ status: 410 \}\);/);
});

test("what stays, stays offered: Cinema Studio 4.0, Motion Transfer, Object Swap, the marketing image and the OpenAI stills", () => {
  for (const id of ["higgsfield-cinema-studio-4.0", "higgsfield/marketing-studio-image", "hf-soul-character", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "fal-ai/flux-lora"]) {
    expect(isOffered(getModel(id)), id).toBe(true);
    expect(retiredReason(id), id).toBeNull();
  }
  expect(MODELS.filter((m) => m.genjutsu).every(isOffered)).toBe(true);
  expect(offeredModels()).toHaveLength(MODELS.length);
  expect(displayModelName("higgsfield-cinema-studio-4.0")).toBe("Cinema Studio 4.0");
  expect(engineLabel("higgsfield-cinema-studio-4.0")).toEqual({ short: "Cinema 4", long: "Cinema Studio 4.0" });
  /* An id nobody registered is not "retired": admission has its own word for an unknown model. */
  expect(retiredReason("no-such-model")).toBeNull();
  expect(retiredReason(null)).toBeNull();
});

test("the offer lists filter on the flag: the engines route and the palette", () => {
  expect(source("app/api/engines/route.ts")).toMatch(/models: offeredModels\(\)\.filter\(/);
  expect(source("components/graphite/Palette.tsx")).toMatch(/MODELS\.filter\(\(m\) => isOffered\(m\) && !m\.hidden\)/);
});

test("an identity still reads Identity still · Standard, · 2 and · Cinema, everywhere a name is made", () => {
  expect(SOUL_VERSION_LABELS).toEqual({ v1: "Identity still · Standard", v2: "Identity still · 2", cinema: "Identity still · Cinema" });
  const names = ["Identity still · Standard", "Identity still · 2", "Identity still · Cinema"];
  SOUL_IDS.forEach((id, i) => {
    expect(displayModelName(id)).toBe(names[i]);
    expect(modelLabel(id)).toBe(names[i]);
    expect(engineLabel(id)).toEqual({ short: "Identity", long: names[i] });
    expect(meteredLine({ kind: "image", model: id })).toEqual({ take: "Still", what: names[i] });
  });
  expect(SOUL_IDS.map(shortLabel)).toEqual(["ID STANDARD", "ID 2", "ID CINEMA"]);
});

test("no model in the registry prints the account's name or the old family word to a customer", () => {
  for (const m of MODELS) {
    for (const text of [m.label, m.short, m.use ?? "", m.note ?? "", displayModelName(m.id), shortLabel(m.id), engineLabel(m.id).long, engineLabel(m.id).short]) {
      expect(text, `${m.id}: ${text}`).not.toMatch(/higgsfield|\bsoul\b/i);
    }
  }
});

test("connected-catalogue ids on stored rows read as what they made, from the earlier account — never the raw id", () => {
  const cases: [string, string][] = [
    ["soul_2", "Identity still (earlier account)"], ["soul_v2", "Identity still (earlier account)"],
    ["text2image_soul_v2", "Identity still (earlier account)"], ["soul_cinematic", "Identity still (earlier account)"],
    ["marketing_studio_image", "Marketing image (earlier account)"], ["ms_image", "Marketing image (earlier account)"],
    ["gpt_image_2_5", "Image (earlier account)"], ["cinematic_studio_2_5", "Image (earlier account)"],
    ["veo3_1", "Video (earlier account)"], ["veo3_1_lite", "Video (earlier account)"], ["cinematic_studio_video", "Video (earlier account)"],
    ["cinematic_studio_3_0", "Video (earlier account)"], ["seed_audio", "Audio (earlier account)"],
    ["multi_image_to_3d", "3D model (earlier account)"], ["meshy_multi_image_to_3d", "3D model (earlier account)"],
    ["virality_predictor", "Video analysis (earlier account)"],
  ];
  for (const [id, label] of cases) {
    expect(displayModelName(id), id).toBe(label);
    expect(modelLabel(id), id).toBe(label);
    expect(engineLabel(id).long, id).toBe(label);
    expect(retiredLabel(id)?.label, id).toBe(label);
    expect(isRetiredModel(id), id).toBe(false); // never in MODELS: nothing to admit, only to name
  }
  for (const { label, short } of Object.values(RETIRED_LABELS)) {
    expect(`${label} ${short}`).not.toMatch(/higgsfield|soul|veo|gpt|seed/i);
    expect(vendorNameIn(label)).toBeNull();
  }
  expect(shortLabel("soul_2")).toBe("IDENTITY");
  expect(engineLabel("veo3_1").short).toBe("Video");
  expect(engineLabel("seed_audio", "audio").short).toBe("Audio");
  /* Every id in the recorded catalogue of the README's removed group has a row. */
  const catalogue = JSON.parse(source("tests/fixtures/connected-models.json")) as unknown;
  const ids = JSON.stringify(catalogue).match(/"id":\s*"([a-z0-9_]+)"/g)?.map((m) => m.replace(/.*"([a-z0-9_]+)"$/, "$1")) ?? [];
  for (const id of ids.filter((x) => /^(soul_(2|v2|cinematic)|veo3_1|cinematic_studio|gpt_image_2_5|seed_audio|multi_image_to_3d|marketing_studio_image|ms_image)/.test(x)))
    expect(retiredLabel(id), id).not.toBeNull();
  /* The OpenAI stills on Particl's own key are a different id (hyphens) and keep their real names. */
  expect(displayModelName("gpt-image-2.5-flare")).toBe("GPT Image 2.5 Flare");
  expect(retiredLabel("gpt-image-2.5-flare")).toBeNull();
  expect(retiredLabel("constructor")).toBeNull();
});

test("an id the registry does not know falls back to the generation's own kind, not always to video", () => {
  expect(engineLabel("some/unknown-model")).toEqual({ short: "Engine", long: "Video engine" });
  expect(engineLabel(null)).toEqual({ short: "Engine", long: "Video engine" });
  expect(engineLabel("some/unknown-model", "image")).toEqual({ short: "Image", long: "Image engine" });
  expect(engineLabel("some/unknown-model", "audio")).toEqual({ short: "Audio", long: "Audio engine" });
  expect(engineLabel("some/unknown-model", "video")).toEqual({ short: "Engine", long: "Video engine" });
  expect(engineLabel("some/unknown-model", "text")).toEqual({ short: "Engine", long: "Video engine" });
  /* A known id answers from the registry whatever the caller says. */
  expect(engineLabel("gemini-3-pro-image", "video")).toEqual({ short: "NB Pro", long: "Nano Banana Pro" });
  expect(engineLabel("gpt-image-2", "video")).toEqual({ short: "Image", long: "Image engine" });
});

test("the provider lookup on the failure path never throws", () => {
  expect(providerOf("hf-soul-2")).toBe("higgsfield");
  expect(providerOf("dreamina-seedance-2-5-260628")).toBe(getModel("dreamina-seedance-2-5-260628").provider);
  for (const m of MODELS) expect(providerOf(m.id)).toBe(m.provider);
  expect(providerOf("soul_2")).toBeNull();
  expect(providerOf("no-such-model")).toBeNull();
  expect(providerOf(null)).toBeNull();
  expect(findModel(undefined)).toBeNull();
  expect(() => getModel("no-such-model")).toThrow(/Unknown model/);
  /* lib/renderWork.ts: the catch that releases a held reservation must not look the model up with the throwing getModel. */
  const work = source("lib/renderWork.ts");
  const caught = work.slice(work.indexOf("A synchronous vendor may have charged"), work.indexOf("await failJob(", work.indexOf("A synchronous vendor may have charged")));
  expect(caught).toContain("providerOf(job.modelId)");
  expect(caught).not.toContain("getModel(");
});

test("a statement's training line reads Identity training, whatever id the meter stored", () => {
  expect(meteredLine({ kind: "training", model: "higgsfield/soul-id" })).toEqual({ take: "Training", what: "Identity training" });
  expect(meteredLine({ kind: "training", model: "fal-ai/flux-lora-portrait-trainer", engine: "fal" })).toEqual({ take: "Training", what: "Identity training" });
});

test("Memory reads a trained identity as Identity, including rows kept under the earlier word", () => {
  expect(REF_SOURCE_LABEL.soul).toBe("Identity");
  expect(IDENTITY_ASSET_KIND).toBe("Identity");
  expect(memoryAssetKind("Soul ID")).toBe("Identity");
  expect(memoryAssetKind("character")).toBe("character");
  expect(memoryAssetKind(null)).toBeNull();
});
