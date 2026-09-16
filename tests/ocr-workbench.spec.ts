import { goWorkbenchStage } from "./helpers/workbenchNavigation";
import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { scannedScreenplayPdf } from "./helpers/screenplayPdf";
import { newProject, type Project } from "../lib/workbench/studio";

async function setup(page: Page) {
  const existingEmail = process.env.PW_OCR_EXISTING_EMAIL;
  if (existingEmail) {
    expect(process.env.PW_BASE_URL).toMatch(
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/,
    );
    expect(existingEmail).toMatch(/^workbench-.+@example\.test$/);
    expect(
      (
        await page.request
          .get("/api/health")
          .then((response) => response.json())
      ).mock,
    ).toBe(true);
    const login = await page.request.post("/api/auth/login", {
      data: {
        email: existingEmail,
        password: "a local browser test passphrase 42",
      },
    });
    expect(login.ok(), await login.text()).toBe(true);
  } else await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`,
    project = newProject("Recognized screenplay");
  if (existingEmail) {
    const listing = await page.request
      .get("/api/workbench/projects", {
        headers: { "X-Workbench-Scope": scope },
      })
      .then((response) => response.json());
    expect(listing.productions.length).toBeGreaterThan(0);
    project.productionProjectId = listing.productions[0].id;
  }
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
  await goWorkbenchStage(page, "script");
  const read = async () =>
    page.request
      .get(
        "/api/workbench/projects?" + new URLSearchParams({ id: project.id }),
        { headers: { "X-Workbench-Scope": scope } },
      )
      .then((response) => response.json()) as Promise<{ project: Project }>;
  return { read };
}
async function fixture() {
  const images = await Promise.all(
    [1, 2].map(async (page) => {
      const lines = [
        `${page} INT. STATION - NIGHT ${page}`,
        "",
        "A distant train crosses the empty platform.",
        "",
        "MARA",
        "We have one more chance.",
        "",
        `Original scan marker ${page}.`,
      ];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1224" height="1584"><rect width="100%" height="100%" fill="white"/><g font-family="monospace" font-size="24" fill="black">${lines.map((line, i) => `<text x="144" y="${160 + i * 36}">${line}</text>`).join("")}</g></svg>`;
      return {
        width: 1224,
        height: 1584,
        jpeg: await sharp(Buffer.from(svg)).jpeg({ quality: 98 }).toBuffer(),
      };
    }),
  );
  return scannedScreenplayPdf(images);
}

test("real local OCR recognizes scan-only PDF, requires individual page review and preserves original bytes and provenance after reload", async ({
  page,
}, testInfo) => {
  const { read } = await setup(page);
  const external: string[] = [],
    errors: string[] = [];
  page.on("request", (request) => {
    if (
      /tesseract|traineddata/.test(request.url()) &&
      new URL(request.url()).origin !== new URL(page.url()).origin
    )
      external.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const pdf = await fixture();
  await page
    .getByLabel("Import screenplay file", { exact: true })
    .setInputFiles({
      name: "Original-scan.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
  const review = page.getByRole("region", { name: "Review screenplay import" }),
    accept = review.getByRole("button", {
      name: "Import complete screenplay",
      exact: true,
    });
  await expect(review).toContainText(
    "Pages 1, 2 contain little or no extractable text.",
  );
  await review
    .getByRole("button", {
      name: "Recognize scanned pages (English)",
      exact: true,
    })
    .click();
  await expect(
    review.getByLabel("Recognized text page 1", { exact: true }),
  ).toHaveValue(/Original scan marker 1/, { timeout: 90000 });
  await expect(accept).toBeDisabled();
  await expect(
    review.getByRole("img", {
      name: "Original screenplay page 1",
      exact: true,
    }),
  ).toBeVisible();
  await review
    .getByText(
      "I reviewed page 1 against the original and corrected its text.",
      { exact: true },
    )
    .click();
  await review
    .getByLabel("Recognized text page 1", { exact: true })
    .fill(
      "1 INT. STATION - NIGHT 1\n\nCorrected line from the original scan.\n\nMARA\nWe have one more chance.",
    );
  const firstCheck = review.getByRole("checkbox", {
    name: "I reviewed page 1 against the original and corrected its text.",
    exact: true,
  });
  await expect(firstCheck).not.toBeChecked();
  await firstCheck.check();
  await review
    .getByRole("button", { name: "Next unreviewed page", exact: true })
    .click();
  await expect(
    review.getByLabel("Recognized text page 2", { exact: true }),
  ).toHaveValue(/Original scan marker 2/);
  const secondCheck = review.getByRole("checkbox", {
    name: "I reviewed page 2 against the original and corrected its text.",
    exact: true,
  });
  await expect(secondCheck).toBeEnabled();
  await secondCheck.check();
  await expect(accept).toBeEnabled();
  await review
    .getByRole("heading", {
      name: "Review recognized pages · 2/2",
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("ocr-page-review.png") });
  await accept.click();
  await expect(review).not.toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => (await read()).project.scriptSource?.ocr?.pages.length)
    .toBe(2);
  const saved = (await read()).project;
  expect(saved.scriptSource?.ocr).toMatchObject({
    language: "eng",
    engine: "tesseract-7.0.0",
    requestedPages: [1, 2],
    pages: [
      { page: 1, reviewed: true, corrected: true },
      { page: 2, reviewed: true, corrected: false },
    ],
  });
  expect(saved.script).toContain("Original scan marker 2");
  expect(saved.script).toContain("Corrected line from the original scan.");
  const original = await page.request.get(
    saved.assets.find((asset) => asset.id === saved.scriptSource?.assetId)!.url,
  );
  expect(original.ok()).toBe(true);
  expect(
    createHash("sha256")
      .update(await original.body())
      .digest("hex"),
  ).toBe(createHash("sha256").update(pdf).digest("hex"));
  await page.reload();
  expect((await read()).project.scriptSource?.ocr).toEqual(
    saved.scriptSource?.ocr,
  );
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("cancelling OCR during language startup stops the worker and retains the existing production", async ({
  page,
}) => {
  test.skip(
    page.viewportSize()!.width !== 1440,
    "one deterministic worker cancellation check",
  );
  const { read } = await setup(page);
  let release!: () => void, requested!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/eng.traineddata.gz", async (route) => {
    requested();
    await blocked;
    await route.abort().catch(() => {});
  });
  await page
    .getByLabel("Import screenplay file", { exact: true })
    .setInputFiles({
      name: "Cancel-scan.pdf",
      mimeType: "application/pdf",
      buffer: await fixture(),
    });
  const review = page.getByRole("region", { name: "Review screenplay import" });
  await review
    .getByRole("button", {
      name: "Recognize scanned pages (English)",
      exact: true,
    })
    .click();
  try {
    await started;
    const ocr = page
      .workers()
      .find((worker) =>
        worker.url().endsWith("/tesseract-7.0.0/worker.min.js"),
      );
    expect(ocr).toBeDefined();
    const closed = ocr!.waitForEvent("close");
    await page
      .getByRole("status")
      .filter({ hasText: "Loading local English OCR" })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await closed;
    await expect(
      review.getByRole("button", { name: "Resume OCR · 2 pages", exact: true }),
    ).toBeEnabled();
    await expect(
      review.getByRole("button", {
        name: "Import complete screenplay",
        exact: true,
      }),
    ).toBeDisabled();
    expect((await read()).project.scriptSource).toBeUndefined();
  } finally {
    release();
  }
});

test("interrupted OCR resumes only unfinished pages and retains recognized text", async ({
  page,
}) => {
  test.skip(
    page.viewportSize()!.width !== 1440,
    "one deterministic partial-page recovery check",
  );
  const { read } = await setup(page);
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    let recognitions = 0;
    window.Worker = class extends NativeWorker {
      postMessage(
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[],
      ) {
        if (
          message &&
          typeof message === "object" &&
          "action" in message &&
          message.action === "recognize"
        ) {
          recognitions++;
          if (recognitions === 2) return;
        }
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
  await page
    .getByLabel("Import screenplay file", { exact: true })
    .setInputFiles({
      name: "Resume-scan.pdf",
      mimeType: "application/pdf",
      buffer: await fixture(),
    });
  const review = page.getByRole("region", { name: "Review screenplay import" });
  await review
    .getByRole("button", {
      name: "Recognize scanned pages (English)",
      exact: true,
    })
    .click();
  const busy = page
    .getByRole("status")
    .filter({ hasText: "Recognizing page 2 of 2" });
  await expect(busy).toBeVisible({ timeout: 60000 });
  await busy.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    review.getByLabel("Recognized text page 1", { exact: true }),
  ).toHaveValue(/Original scan marker 1/);
  const firstText = await review
    .getByLabel("Recognized text page 1", { exact: true })
    .inputValue();
  await expect(
    review.getByRole("button", {
      name: "Import complete screenplay",
      exact: true,
    }),
  ).toBeDisabled();
  await review
    .getByRole("button", { name: "Resume OCR · 1 pages", exact: true })
    .click();
  await expect(
    review.getByLabel("Recognized text page 1", { exact: true }),
  ).toHaveValue(firstText, { timeout: 60000 });
  await review.getByLabel("OCR page", { exact: true }).selectOption("2");
  await expect(
    review.getByLabel("Recognized text page 2", { exact: true }),
  ).toHaveValue(/Original scan marker 2/);
  expect((await read()).project.scriptSource).toBeUndefined();
});
