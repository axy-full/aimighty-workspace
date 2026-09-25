import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { trainApproval, trainApprovalProblem, trainingPhotos, trainPrice } from "../../lib/identityTraining";
import { billCredits } from "../../lib/creditTerms";

process.env.ENGINE_MOCK = "1";

/* The New asset sheet's "Train the face now" (components/assets/NewAssetSheet).
   In a credit workspace GET /api/identities quotes `trainCredits` and leaves
   `trainCostUsd` null; the sheet read only the dollars, showed "0 cr", and
   the run was still billed. */
test("the training price is read in the unit the workspace pays in, and unknown is not zero", () => {
  const credits = { configured: true, minPhotos: 5, trainCostUsd: null, trainCredits: 54 };
  const dollars = { configured: true, minPhotos: 5, trainCostUsd: 3.6, trainCredits: null };
  expect(trainPrice(credits, true)).toBe(54);
  expect(trainPrice(dollars, false)).toBe(3.6);
  // The other unit's field is not a price in this one: unknown, never 0.
  expect(trainPrice(credits, false)).toBeNull();
  expect(trainPrice(dollars, true)).toBeNull();
  expect(trainPrice(undefined, true)).toBeNull();
});

test("only uploaded stills count as training photos; takes and clips do not", () => {
  const refs = [
    { uploadId: "up1", kind: "image" },
    { genId: "gen1", uploadId: null, kind: "image" },
    { uploadId: "up2", kind: "video" },
    { uploadId: "up3", kind: "image" },
    { uploadId: "up1", kind: "image" },
  ];
  expect(trainingPhotos(refs)).toEqual(["up1", "up3"]);
  // Five takes are five references and zero training photos.
  expect(trainingPhotos(Array.from({ length: 5 }, (_, i) => ({ genId: `g${i}`, kind: "image" })))).toEqual([]);
});

test("the approval carries the shown price, and a higher charge is refused", () => {
  expect(trainApproval(54, true)).toEqual({ maxCredits: 54 });
  expect(trainApproval(3.6, false)).toEqual({ maxUsd: 3.6 });
  const charge = { credits: 54, usd: 3.6 };
  expect(trainApprovalProblem({ maxCredits: 54 }, charge)).toBeNull();
  expect(trainApprovalProblem({ maxUsd: 3.6 }, charge)).toBeNull();
  expect(trainApprovalProblem({}, charge)).toBeNull();
  expect(trainApprovalProblem({ maxCredits: 53 }, charge)).toContain("price changed");
  expect(trainApprovalProblem({ maxCredits: 0 }, charge)).toContain("price changed");
  expect(trainApprovalProblem({ maxCredits: "54" }, charge)).toContain("price changed");
  expect(trainApprovalProblem({ maxCredits: 54.5 }, charge)).toContain("price changed");
  expect(trainApprovalProblem({ maxUsd: 3.59 }, charge)).toContain("price changed");
});

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const load = (file: string, dependencies: Record<string, unknown>) => {
  const compiled = ts.transpileModule(readFileSync(path.join(process.cwd(), file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, mod, mod.exports);
  return mod.exports;
};
const nextServer = () => createRequire(path.resolve("package.json"))("next/server");

test("the train route refuses a run that costs more than the approved price, before any money check", async () => {
  const usd = 3.6;
  const started: string[] = [], walls: number[] = [];
  const route = load("app/api/identities/[id]/train/route.ts", {
    "next/server": nextServer(),
    "@/lib/auth": { requireRender: async () => ({ user: { id: "caller" } }), withTenant: (h: Handler) => h },
    "@/lib/identities": { trainCostUsd: () => usd, startTraining: async (id: string) => { started.push(id); return { id, status: "training" }; } },
    "@/lib/allowance": { allowanceCheck: async (_v: string, cost: number) => { walls.push(cost); return { ok: true }; } },
    "@/lib/limits": { checkLimits: async () => ({ allow: true }) },
    "@/lib/creditTerms": { billCredits },
    "@/lib/identityTraining": { trainApprovalProblem },
    "@/lib/generationRequests": { withGenerationRequest: (_r: Request, _u: string, run: () => Promise<Response>) => run(), SpendReservationError: class extends Error {} },
  });
  const post = (body: unknown) => route.POST(
    new Request("http://localhost/api/identities/idn_1/train", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "idn_1" }) },
  );
  const credits = billCredits(usd, "identity-training");
  const low = await post({ consent: true, maxCredits: credits - 1 });
  expect(low.status).toBe(409);
  expect((await low.json()).error).toContain("price changed");
  expect(started).toEqual([]);
  expect(walls).toEqual([]);

  const cheap = await post({ consent: true, maxUsd: usd - 0.01 });
  expect(cheap.status).toBe(409);
  expect(started).toEqual([]);

  const approved = await post({ consent: true, maxCredits: credits });
  expect(approved.status).toBe(202);
  expect(started).toEqual(["idn_1"]);
  expect(walls).toEqual([usd]);
});

test("a retried New asset hands back the caller's own untrained identity instead of a name clash", async () => {
  const fixtures = [
    { id: "idn_other", name: "Iver", createdBy: "someone-else", projectId: null, status: "draft", loraUrl: null, castId: null },
    { id: "idn_trained", name: "Mara", createdBy: "caller", projectId: null, status: "failed", loraUrl: "https://lora", castId: null },
    { id: "idn_mine", name: "Iver", createdBy: "caller", projectId: null, status: "failed", loraUrl: null, castId: null },
  ];
  const updated: { id: string; photos: string[] }[] = [], created: string[] = [];
  const route = load("app/api/identities/route.ts", {
    "next/server": nextServer(),
    "@/lib/allowance": { allowanceCheck: async () => ({ ok: true }) },
    "@/lib/auth": { requireUser: async () => ({ user: { id: "caller" } }), withTenant: (h: Handler) => h },
    "@/lib/identities": {
      listIdentities: async () => fixtures,
      updateIdentity: async (id: string, patch: { photos: string[] }) => { updated.push({ id, photos: patch.photos }); return { ...fixtures.find((f) => f.id === id), photos: patch.photos }; },
      createIdentity: async (input: { name: string }) => { created.push(input.name); if (input.name === "Iver") throw new Error("There is already an identity called Iver."); return { id: "idn_new", name: input.name }; },
      syncIdentity: async () => ({}), MIN_PHOTOS: 5, MAX_PHOTOS: 40, RECOMMENDED_PHOTOS: "", TRAIN_STEPS: 1500, trainCostUsd: () => 3.6, RENDER_USD_PER_MP: 0.035, TRAINER: "trainer",
    },
    "@/lib/fal": { falConfigured: () => true },
    "@/lib/credits": { creditsApply: () => true },
    "@/lib/creditTerms": { billCredits },
    "@/lib/tenant": { currentTenant: () => null },
  });
  const post = (body: unknown) => route.POST(
    new Request("http://localhost/api/identities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "" }) },
  );
  const again = await post({ name: "iver", photos: ["up1", "up2"], projectId: null, reuseDraft: true });
  expect(again.status).toBe(200);
  expect((await again.json()).identity.id).toBe("idn_mine");
  expect(updated).toEqual([{ id: "idn_mine", photos: ["up1", "up2"] }]);
  expect(created).toEqual([]);

  // A trained identity is never taken over, and without reuseDraft the clash stands.
  expect((await post({ name: "Mara", photos: [], reuseDraft: true })).status).toBe(201);
  expect(created).toEqual(["Mara"]);
  expect((await post({ name: "Iver", photos: [] })).status).toBe(400);
});
