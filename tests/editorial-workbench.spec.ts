import { goWorkbenchStage as stage, openWorkbenchInspector, openWorkbenchBins, closeWorkbenchBins } from "./helpers/workbenchNavigation";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject } from "../lib/workbench/studio";
import { legacyShell } from "./helpers/legacyShell";

test("asset bins and named cuts persist, recover a lost save, restore clip audio and timing, and export an intact version", async ({
  page,
}, info) => {
  await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`,
    headers = { "X-Workbench-Scope": scope };
  const p = seedProject();
  p.name = "Editorial rehearsal";
  p.nodes[0].text = "Keep the newer canvas direction";
  const saved = await page.request.put("/api/workbench/projects", {
    headers,
    data: { project: p, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const read = () =>
    page.request
      .get("/api/workbench/projects?id=" + p.id, { headers })
      .then((r) => r.json());
  const history = () =>
    page.request
      .get("/api/workbench/edit-versions?draftId=" + p.id, { headers })
      .then((r) => r.json());
  await page.goto(await legacyShell(page, "/workbench"));
  await stage(page, "assets");
  await openWorkbenchBins(page);
  await page.getByLabel("Bin name", { exact: true }).fill("Director selects");
  await page.getByRole("button", { name: "New bin", exact: true }).click();
  await page.getByLabel("Asset bin", { exact: true }).selectOption("");
  await closeWorkbenchBins(page);
  if (page.viewportSize()!.width >= 1100)
    await page
      .getByRole("article", { name: "Asset: The encounter", exact: true })
      .click({ button: "right" });
  else
    await page
      .getByRole("button", { name: "Actions for The encounter", exact: true })
      .click();
  await page
    .getByRole("menuitem", { name: "Organize in bins", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Organize The encounter" });
  await dialog.getByLabel("Director selects", { exact: true }).check();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(async () => ((await read()).project.bins ?? [])[0]?.assetIds)
    .toEqual(["hero"]);
  const binId = (await read()).project.bins[0].id;
  await openWorkbenchBins(page);
  await page.getByLabel("Asset bin", { exact: true }).selectOption(binId);
  await closeWorkbenchBins(page);
  await expect(
    page.getByRole("article", { name: "Asset: The encounter", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", {
      name: "Asset: The mirrored dunes",
      exact: true,
    }),
  ).toHaveCount(0);
  await openWorkbenchBins(page);
  await page.getByLabel("Asset bin", { exact: true }).selectOption("unfiled");
  await closeWorkbenchBins(page);
  await expect(
    page.getByRole("article", { name: "Asset: The encounter", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await stage(page, "assets");
  await openWorkbenchBins(page);
  await expect(page.getByLabel("Asset bin", { exact: true })).toContainText(
    "Director selects",
  );
  await closeWorkbenchBins(page);
  await stage(page, "edit");
  await openWorkbenchInspector(page, "versions");
  if (info.project.name === "workbench-1440x900") {
    let lost = false;
    await page.route("**/api/workbench/edit-versions", async (route) => {
      if (route.request().method() !== "POST" || lost) return route.continue();
      lost = true;
      const result = await route.fetch();
      expect(result.ok(), await result.text()).toBe(true);
      await route.abort("failed");
    });
  }
  const versions = page.getByRole("region", {
    name: "Edit versions",
    exact: true,
  });
  await versions
    .getByLabel("Edit version name", { exact: true })
    .fill("Assembly A");
  await versions
    .getByRole("button", { name: "Save edit version", exact: true })
    .click();
  await expect(versions.getByRole("status")).toContainText(
    "Saved “Assembly A”",
  );
  expect((await history()).versions).toHaveLength(1);
  await openWorkbenchInspector(page, "shot");
  await page.locator("#shot-duration").fill("2");
  await page.locator("#shot-duration").blur();
  await expect
    .poll(async () => (await read()).project.shots[0].duration)
    .toBe(48);
  await openWorkbenchInspector(page, "versions");
  await versions.getByLabel("Edit version name").fill("Assembly B");
  await versions
    .getByRole("button", { name: "Save edit version", exact: true })
    .click();
  await expect(versions.getByRole("status")).toContainText(
    "Saved “Assembly B”",
  );
  await versions
    .getByRole("button", { name: "Restore Assembly A", exact: true })
    .click();
  await expect(versions.getByRole("status")).toContainText(
    "Restored “Assembly A”",
  );
  await expect
    .poll(async () => (await read()).project.shots[0].duration)
    .toBe(96);
  const current = (await read()).project;
  expect(current.nodes[0].text).toBe("Keep the newer canvas direction");
  expect(current.bins[0].assetIds).toEqual(["hero"]);
  expect(current.clipAudio).toBe(true);
  const retained = (await history()).versions;
  expect(retained).toHaveLength(3);
  expect(
    retained.some(
      (v: { label: string }) => v.label === "Before restoring Assembly A",
    ),
  ).toBe(true);
  const row = versions
    .getByRole("listitem")
    .filter({ has: page.getByText("Assembly A", { exact: true }) });
  const downloading = page.waitForEvent("download");
  await row
    .getByRole("button", { name: "Download version", exact: true })
    .click();
  const file = await downloading;
  await file.saveAs(info.outputPath("assembly-a.json"));
  const exported = JSON.parse(
    await readFile(info.outputPath("assembly-a.json"), "utf8"),
  );
  expect(exported.edit.shots[0].duration).toBe(96);
  expect(exported.version.hash).toBe(
    createHash("sha256").update(JSON.stringify(exported.edit)).digest("hex"),
  );
  expect(
    (
      await page.request.get("/api/workbench/edit-versions?draftId=" + p.id, {
        headers: { "X-Workbench-Scope": "stale" },
      })
    ).status(),
  ).toBe(409);
  await page.reload();
  await stage(page, "edit");
  await openWorkbenchInspector(page, "versions");
  await expect(
    versions.getByRole("button", { name: "Restore Assembly A", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByLabel("Edit inspector", { exact: true }).evaluate((el) => {
    el.scrollTop = 0;
    el.scrollIntoView({ block: "start" });
  });
  await page.screenshot({ path: info.outputPath("named-cuts.png") });
  expect(errors).toEqual([]);
});
