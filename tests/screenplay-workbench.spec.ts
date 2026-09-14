import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { screenplayPdf } from "./helpers/screenplayPdf";
import { newProject, STAGES, type Project } from "../lib/workbench/studio";

async function scriptStage(page: Page) {
  if (page.viewportSize()!.width < 760) {
    await page
      .getByRole("navigation", { name: "Mobile studio navigation" })
      .getByRole("button", { name: "Workflow", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Production workflow" })
      .locator(".mobile-workflow-list button")
      .filter({ hasText: "Script & breakdown" })
      .click();
  } else
    await page
      .locator(".workflow-stages")
      .getByRole("tab")
      .nth(STAGES.findIndex((s) => s.id === "script"))
      .click();
}

test("complete PDF screenplay retains pages, beats, original asset and all 120 scene nodes after reload", async ({
  page,
}, testInfo) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  const project = newProject("Feature screenplay");
  const save = await page.request.put("/api/workbench/projects", {
    headers: { "X-Workbench-Scope": scope },
    data: { project, revision: 0 },
  });
  expect(save.ok(), await save.text()).toBeTruthy();
  await page.goto("/workbench");
  await page.evaluate(({ scope, id }) => localStorage.setItem(scope, id), {
    scope,
    id: project.id,
  });
  await page.reload();
  await scriptStage(page);
  const pdf = screenplayPdf(
    Array.from({ length: 120 }, (_, i) => [
      `${i + 1} EXT. LOCATION ${i + 1} - DAY ${i + 1}`,
      "",
      ...Array(15).fill(
        "The camera holds as the performer crosses the room and opens the window.",
      ),
      "",
      "MARA",
      "I remember this moment.",
      `Final source marker ${i + 1}.`,
    ]),
  );
  await page
    .getByLabel("Import screenplay file", { exact: true })
    .setInputFiles({
      name: "Feature-final.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
  const review = page.getByRole("region", { name: "Review screenplay import" });
  await expect(review).toContainText("120 PDF pages", { timeout: 60000 });
  await review
    .getByRole("button", { name: "Import complete screenplay", exact: true })
    .click();
  await expect(review).not.toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Import screenplay", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("screenplay-source.png") });
  await expect(
    page.getByLabel("Production screenplay", { exact: true }),
  ).toHaveValue(/Final source marker 120\./);
  await expect(
    page.getByRole("region", { name: "Screenplay scene breakdown" }),
  ).toContainText("120 scenes");
  const read = async () =>
    page.request
      .get(
        "/api/workbench/projects?" + new URLSearchParams({ id: project.id }),
        { headers: { "X-Workbench-Scope": scope } },
      )
      .then((r) => r.json()) as Promise<{ project: Project }>;
  await expect
    .poll(async () => (await read()).project.scriptSource?.pages.length)
    .toBe(120);
  const stored = (await read()).project;
  expect(stored.script!.length).toBeGreaterThan(100000);
  expect(stored.scriptSource?.sha256).toBe(
    createHash("sha256").update(pdf).digest("hex"),
  );
  const original = await page.request.get(
    stored.assets.find((a) => a.id === stored.scriptSource?.assetId)!.url,
  );
  expect(original.ok()).toBe(true);
  expect(
    createHash("sha256")
      .update(await original.body())
      .digest("hex"),
  ).toBe(stored.scriptSource?.sha256);
  await page
    .getByLabel("Scene intent scene-01", { exact: true })
    .fill("Move from caution to resolve.");
  const first = page
    .locator("article")
    .filter({ has: page.getByLabel("Scene intent scene-01", { exact: true }) });
  await first.getByText("Beats · 0", { exact: true }).click();
  await first.getByRole("button", { name: "Add beat", exact: true }).click();
  await page
    .getByLabel("Beat 1 scene-01", { exact: true })
    .fill("She chooses to open the window.");
  await expect
    .poll(
      async () => (await read()).project.scriptReviews?.["scene-01"]?.beats[0],
    )
    .toBe("She chooses to open the window.");
  await page.screenshot({
    path: testInfo.outputPath("screenplay-breakdown.png"),
    fullPage: false,
  });
  await page.reload();
  await scriptStage(page);
  await expect(
    page.getByLabel("Scene intent scene-01", { exact: true }),
  ).toHaveValue("Move from caution to resolve.");
  await page
    .getByRole("button", { name: "Select all scenes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Build 120 scene nodes", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await read()).project.nodes.filter((n) => n.scriptScene).length,
      { timeout: 30000 },
    )
    .toBe(120);
  const final = (await read()).project;
  expect(final.nodes[0].text).toContain("She chooses to open the window.");
  expect(final.nodes.at(-1)?.text).toContain("Final source marker 120.");
  expect(final.nodes.at(-1)?.scriptScene?.pageStart).toBe(120);
  await page.reload();
  await expect.poll(async () => (await read()).project.nodes.length).toBe(120);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("PDF pages without text require explicit review and cannot silently replace a saved script", async ({
  page,
}) => {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  const project = {
    ...newProject("Scanned-page review"),
    script: "INT. ORIGINAL - DAY\nKeep this screenplay.",
  };
  expect(
    (
      await page.request.put("/api/workbench/projects", {
        headers: { "X-Workbench-Scope": scope },
        data: { project, revision: 0 },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/workbench");
  await page.evaluate(({ scope, id }) => localStorage.setItem(scope, id), {
    scope,
    id: project.id,
  });
  await page.reload();
  await scriptStage(page);
  await page
    .getByLabel("Import screenplay file", { exact: true })
    .setInputFiles({
      name: "Scanned.pdf",
      mimeType: "application/pdf",
      buffer: screenplayPdf([["INT. NEW - DAY", "Some source text."], []]),
    });
  const review = page.getByRole("region", { name: "Review screenplay import" });
  await expect(review).toContainText(
    "Pages 2 contain little or no extractable text.",
  );
  await expect(
    review.getByRole("button", {
      name: "Import complete screenplay",
      exact: true,
    }),
  ).toBeDisabled();
  await review
    .getByRole("button", { name: "Cancel import", exact: true })
    .click();
  await expect(
    page.getByLabel("Production screenplay", { exact: true }),
  ).toHaveValue(project.script);
});
