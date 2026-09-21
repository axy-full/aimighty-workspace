import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Viral = Genjutsu (FINAL_SPEC §1 step 3) in the browser: the well's rule
 * (one 4–30 s video, ≥1 image), the live estimate on the button, submit at
 * that exact price, and History with Recreate · Compare · Send to Edit.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-viral", productionProjectId: "prod-ws", shotMappings: {} });
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const GEN = "gen_hfc_" + "a".repeat(40);

async function open(page: Page, sp: "motion" | "swap" | "history", options: { jobs?: Record<string, unknown>[] } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_src", filename: "walk.mp4", mime: "video/mp4", kind: "video", durationS: 12 }), upload({ id: "up_long", filename: "long.mp4", mime: "video/mp4", kind: "video", durationS: 45 }), upload({ id: "up_ref", filename: "mira.png", mime: "image/png" })],
    generations: [generation({ id: "gen_still", title: "Dunes still", prompt: "dunes" })],
  });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  const posts: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [...(options.jobs ?? [])];
  await page.route("**/api/higgsfield/consumer/genjutsu**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, maxImages: 30, maxMediaBytes: 52428800 }, jobs } });
    const body = req.postDataJSON() as Record<string, unknown>;
    posts.push(body);
    const base = { draftId: "ws-viral", workspaceId: WALLET, workspaceName: "Fixture wallet", creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: null };
    if (body.action === "quote") { const job = { ...base, id: "11111111-1111-4111-8111-000000000001", status: "quoted", input: body.input, quoteCredits: 22 }; return route.fulfill({ json: { job } }); }
    if (body.action === "submit") {
      if (body.credits !== 22 || body.workspaceId !== WALLET) return route.fulfill({ status: 409, json: { code: "approval_changed", error: "Review this job’s wallet and exact credit quote again." } });
      const job = { ...base, id: body.id, status: "accepted", input: (posts.find((p) => p.action === "quote") as { input: unknown }).input, quoteCredits: 22, providerJobId: "22222222-2222-4222-8222-000000000002" };
      jobs.unshift(job);
      return route.fulfill({ json: { job } });
    }
    if (body.action === "status") { const job = { ...jobs[0], status: "completed", originalAvailable: true, originalAvailability: "available", result: { original: { generationId: GEN, asset: { generationId: GEN, url: `/api/media/${GEN}`, kind: "video", mime: "video/mp4" } } } }; jobs[0] = job; return route.fulfill({ json: { job } }); }
    return route.fulfill({ status: 400, json: { error: "unexpected" } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?suite=subatomik&page=${sp}&sp=${sp}`);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, posts, jobs };
}

const dropInto = async (page: Page, id: string) => page.getByTestId("viral-well").evaluate((well, payload) => {
  const data = new DataTransfer(); data.setData("text/plain", payload);
  well.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
}, id);

test("Motion Transfer needs one 4–30 s video and a reference; the button wears the live estimate; submit carries exactly that price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, posts } = await open(page, "motion");
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "motion");
  await expect(page.getByTestId("page-title")).toHaveText("Motion Transfer");
  await expect(page.getByTestId("viral-reason")).toHaveText("Add one source video (4–30 s).");
  await dropInto(page, "upload:up_long");
  await expect(page.getByTestId("viral-note")).toHaveText("The source video must be 4–30 s; this one is 45 s.");
  await dropInto(page, "upload:up_src");
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4 · 12 s");
  await expect(page.getByTestId("viral-reason")).toHaveText("Add at least one reference image.");
  await dropInto(page, "upload:up_ref");
  await dropInto(page, "generation:gen_still");
  await expect(page.getByTestId("viral-reference")).toHaveCount(2);
  await page.getByRole("button", { name: "Move Dunes still earlier" }).click();
  await expect(page.getByTestId("viral-reference").first()).toContainText("Dunes still");
  await expect(page.getByTestId("viral-generate")).toHaveText("Transfer motion · 22 cr");
  const quote = posts.find((p) => p.action === "quote") as { input: Record<string, unknown> };
  expect(quote.input).toEqual({ variant: "motion-transfer", resolution: "720p", prompt: "", source: { uploadId: "up_src" }, references: [{ genId: "gen_still" }, { uploadId: "up_ref" }] });
  await page.getByTestId("viral-generate").click();
  await expect(page.getByTestId("viral-done")).toContainText("Rendered.", { timeout: 15_000 });
  expect(posts.find((p) => p.action === "submit")).toMatchObject({ action: "submit", credits: 22, workspaceId: WALLET, id: "11111111-1111-4111-8111-000000000001" });
  expect(errors).toEqual([]);
});

test("Object Swap has its own words; History offers Recreate, Compare and Send to Edit", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const done = { id: "33333333-3333-4333-8333-000000000003", draftId: "ws-viral", status: "completed", input: { variant: "object-swap", resolution: "1080p", prompt: "swap the bottle", source: { uploadId: "up_src" }, references: [{ uploadId: "up_ref" }] }, workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: 34, creditUnit: "higgsfield_credits", quoteExpiresAt: 0, createdAt: Date.now() - 60_000, providerJobId: "22222222-2222-4222-8222-000000000002", originalAvailable: true, originalAvailability: "available", result: { original: { generationId: GEN, asset: { generationId: GEN, url: `/api/media/${GEN}`, kind: "video", mime: "video/mp4" } } } };
  await open(page, "swap", { jobs: [done] });
  await expect(page.getByTestId("page-title")).toHaveText("Object Swap");
  await expect(page.getByTestId("viral-view")).toContainText("Swap one element");
  await expect(page.getByTestId("viral-prompt")).toHaveAttribute("placeholder", "Replace the bottle with the Glow serum; keep the hands as filmed.");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /History/ }).click();
  await expect(page.getByTestId("history-view")).toBeVisible();
  const result = page.getByTestId("history-result");
  await expect(result).toHaveCount(1);
  await expect(result).toContainText("Object Swap · 1080p");
  await expect(result).toContainText("34 cr settled");
  await result.getByRole("button", { name: "Compare" }).click();
  const compare = page.getByRole("dialog", { name: "Compare" });
  await expect(compare).toBeVisible();
  await expect(compare.locator("video")).toHaveCount(2);
  await compare.getByRole("button", { name: "Close" }).click();
  await result.getByRole("button", { name: "Recreate" }).click();
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "swap");
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4");
  await expect(page.getByTestId("viral-prompt")).toHaveValue("swap the bottle");
  await expect(page.getByTestId("viral-generate")).toHaveText("Swap object · 22 cr");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /History/ }).click();
  await page.getByTestId("history-result").getByRole("button", { name: "Send to Edit" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Edit & Sound");
  if (wide) await expect(page.getByTestId("inspector")).toBeVisible();
});
