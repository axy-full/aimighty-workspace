import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Studio › Cast › Build identity on the connected account (FINAL_SPEC §3 ›
 * Soul ID): the card blocks with the reason until a name, 5–20 stills and
 * the plan gate are in place; the button asks once more with the exact
 * request on it; the account's reply is shown word for word; the account's
 * existing Soul IDs are listed with Use in Gen on the ready ones.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const fixture = (): Project => ({ ...newProject("Dune Studies"), id: "ws-soul", productionProjectId: "prod-soul", shotMappings: {} });

async function open(page: Page, plan: unknown, build: unknown) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [1, 2, 3].map((n) => upload({ id: `up_${n}`, filename: `mira-${n}.webp` })),
    generations: [4, 5, 6].map((n) => generation({ id: `gen_${n}`, title: `Mira ${n}`, prompt: `Mira ${n}` })),
  });
  const calls: Record<string, unknown>[] = [];
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    if (body.action === "characters-plan") return route.fulfill({ json: { plan } });
    if (body.action === "characters") return route.fulfill({ json: { connected: true, available: true, characters: [{ soulId: "soul_ready", name: "Ada", type: "soul_cinematic", status: "ready", previewUrl: null }, { soulId: "soul_train", name: "Kai", type: "soul_2", status: "training", previewUrl: null }] } });
    if (body.action === "characters-create") return route.fulfill({ json: { build } });
    return route.fallback();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=cast");
  await expect(page.getByTestId("project-name")).toHaveText("Dune Studies");
  return { errors, calls };
}

test("Build identity: the reasons, the plan gate, the confirm with the exact request, the account's answer, and the list", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  const { errors, calls } = await open(page, { connected: true, available: true, plan: "Pro", paid: true }, { state: "training", character: { soulId: "soul_new", name: "Mira", type: "soul_2", status: "training", previewUrl: null } });
  const card = page.getByTestId("soul-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("soul-blocked")).toHaveText("Name the identity.");
  await page.getByTestId("soul-name").fill("Mira");
  await expect(page.getByTestId("soul-blocked")).toHaveText("Pick 5–20 stills of the same person (0 picked).");
  await expect(page.getByTestId("soul-plan")).toContainText("The account reads as Pro — a paid plan.");
  await expect(page.getByTestId("soul-plan")).toContainText("billed by the connected account at its plan’s rate; the account offers no quote for it");

  /* The six stills of this project: three uploads, three renders. Five picked. */
  const stills = page.getByTestId("soul-stills").getByRole("button");
  await expect(stills).toHaveCount(6);
  for (const id of ["up_1", "up_2", "up_3", "gen_4", "gen_5"]) await page.getByTestId(`soul-still-${id}`).click();
  await expect(page.getByTestId("soul-blocked")).toHaveCount(0);
  await page.getByTestId("soul-type-soul_cinematic").click();

  /* Particl-built identities only (the route already narrowed them), with Use in Gen only on the ready one. */
  await expect(page.getByTestId("soul-row-soul_ready")).toContainText("Ada");
  await expect(page.getByTestId("soul-row-soul_ready").getByRole("button", { name: "Use in Gen" })).toBeEnabled();
  await expect(page.getByTestId("soul-row-soul_train").getByRole("button", { name: "Use in Gen" })).toBeDisabled();

  /* Confirm once more with the exact request; the account's reply is shown. */
  await page.getByTestId("soul-build").click();
  await expect(page.getByTestId("soul-build-confirm")).toHaveText("Train Mira · Soul Cinematic · 5 stills");
  await page.getByTestId("soul-build-confirm").click();
  await expect(page.getByTestId("soul-outcome")).toHaveText("Mira · Soul 2 · Training · soul_id soul_new");
  const create = calls.find((c) => c.action === "characters-create")!;
  expect(create).toEqual({ action: "characters-create", name: "Mira", type: "soul_cinematic", sources: [{ uploadId: "up_1" }, { uploadId: "up_2" }, { uploadId: "up_3" }, { genId: "gen_4" }, { genId: "gen_5" }], projectId: "ws-soul" });
  await expect(page.getByTestId("toast")).toHaveText("Mira is training on the account");
  expect(errors).toEqual([]);
});

test("a free plan blocks before the button; a refusal comes back in the account's words", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  const { errors } = await open(page, { connected: true, available: true, plan: "Free", paid: false }, { state: "refused", reason: "Soul ID training requires a paid plan." });
  await page.getByTestId("soul-name").fill("Mira");
  for (const id of ["up_1", "up_2", "up_3", "gen_4", "gen_5"]) await page.getByTestId(`soul-still-${id}`).click();
  await expect(page.getByTestId("soul-blocked")).toHaveText("A paid Higgsfield plan is required — the account reads as Free.");
  await expect(page.getByTestId("soul-build")).toBeDisabled();
  expect(errors).toEqual([]);
});
