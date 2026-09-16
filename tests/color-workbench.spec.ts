import { goWorkbenchStage as stage, openWorkbenchInspector } from "./helpers/workbenchNavigation";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import ts from "typescript";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";

test("GPU color interpolation matches the CPU reference with domains, partial mix and image orientation", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "workbench-1440x900",
    "One GPU interpolation and orientation regression.",
  );
  for (const name of ["color-render", "color-lut", "color"]) {
    const source = await readFile(`lib/workbench/${name}.ts`, "utf8");
    const js = ts
      .transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      })
      .outputText.replace(
        /from "\.\/(color-lut|color)"/g,
        'from "/__color-test__/$1.js"',
      );
    await page.route(`**/__color-test__/${name}.js`, (route) =>
      route.fulfill({ body: js, contentType: "text/javascript" }),
    );
  }
  await page.goto("/");
  const samples = await page.evaluate(async () => {
    const rendererUrl = "/__color-test__/color-render.js",
      cubeUrl = "/__color-test__/color-lut.js";
    const { createColorRenderer } = (await import(
      rendererUrl
    )) as typeof import("../lib/workbench/color-render");
    const { parseCube, sampleCube } = (await import(
      cubeUrl
    )) as typeof import("../lib/workbench/color-lut");
    const rows = Array.from({ length: 27 }, (_, i) => {
      const r = (i % 3) / 2,
        g = (Math.floor(i / 3) % 3) / 2,
        b = Math.floor(i / 9) / 2;
      return `${g * g} ${b * b} ${r * r}`;
    }).join("\n");
    const lut = parseCube(
        `LUT_3D_SIZE 3\nDOMAIN_MIN -0.1 0 0\nDOMAIN_MAX 0.9 1 2\n${rows}`,
      ),
      renderer = createColorRenderer(lut);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext("2d")!,
        bytes = new Uint8ClampedArray([
          255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 64, 128, 192, 255,
        ]);
      ctx.putImageData(new ImageData(bytes, 2, 2), 0, 0);
      const result = renderer.render(canvas, {
        mix: 0.4,
        brightness: 1,
        contrast: 1,
        saturation: 1,
        bypassed: false,
      });
      const output = document.createElement("canvas");
      output.width = 2;
      output.height = 2;
      const out = output.getContext("2d")!;
      out.drawImage(result, 0, 0);
      const actual = [...out.getImageData(0, 0, 2, 2).data];
      const expected = Array.from({ length: 4 }, (_, i) => {
        const rgb = [...bytes.slice(i * 4, i * 4 + 3)].map((n) => n / 255),
          mapped = sampleCube(lut, rgb);
        return [
          ...rgb.map((v, j) => Math.round((v * 0.6 + mapped[j] * 0.4) * 255)),
          255,
        ];
      }).flat();
      return { actual, expected };
    } finally {
      renderer.dispose();
    }
  });
  samples.actual.forEach((value, index) =>
    expect(Math.abs(value - samples.expected[index])).toBeLessThanOrEqual(1),
  );
});


test("imported LUTs save, grade actual preview pixels, bypass cleanly, and match the encoded movie and editorial originals", async ({
  page,
}, info) => {
  const existingEmail = process.env.PW_COLOR_EXISTING_EMAIL;
  if (existingEmail) {
    expect(process.env.PW_BASE_URL).toMatch(
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/,
    );
    expect(existingEmail).toMatch(/^workbench-.+@example\.test$/);
    expect(
      (await page.request.get("/api/health").then((r) => r.json())).mock,
    ).toBe(true);
    const login = await page.request.post("/api/auth/login", {
      data: {
        email: existingEmail,
        password: "a local browser test passphrase 42",
      },
    });
    expect(login.ok(), await login.text()).toBe(true);
  } else await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`,
    headers = { "X-Workbench-Scope": scope };
  const bytes = await sharp({
    create: {
      width: 256,
      height: 128,
      channels: 3,
      background: { r: 64, g: 128, b: 192 },
    },
  })
    .png()
    .toBuffer();
  const session = randomUUID();
  const chunk = await page.request.post("/api/uploads/chunk", {
    headers,
    multipart: {
      session,
      index: "0",
      chunk: {
        name: "chunk",
        mimeType: "application/octet-stream",
        buffer: bytes,
      },
    },
  });
  expect(chunk.ok(), await chunk.text()).toBe(true);
  const uploadResponse = await page.request.post("/api/uploads/finish", {
    headers,
    data: { session, count: 1, filename: "Test plate.png", purpose: "chat" },
  });
  expect(uploadResponse.ok(), await uploadResponse.text()).toBe(true);
  const upload = await uploadResponse.json();
  const project = newProject("Color proof");
  let revision = 0;
  if (existingEmail) {
    // Keep the isolated account's existing production within its real plan cap.
    const list = await page.request
      .get("/api/workbench/projects", { headers })
      .then((r) => r.json());
    if (list.projects[0]) {
      const prior = await page.request
        .get(
          "/api/workbench/projects?" +
            new URLSearchParams({ id: list.projects[0].id }),
          { headers },
        )
        .then((r) => r.json());
      project.id = prior.project.id;
      project.productionProjectId = prior.project.productionProjectId;
      revision = prior.revision;
    }
  }
  project.assets = [
    {
      id: upload.id,
      uploadId: upload.id,
      name: "Test plate.png",
      kind: "image",
      category: "Shot",
      url: upload.url,
      mime: "image/png",
      description: "Synthetic pixel reference",
      prompt: "",
      status: "Selected",
      version: 1,
      locked: false,
      refs: [],
    },
  ];
  project.shots = [
    {
      id: "shot",
      name: "Color test",
      assetId: upload.id,
      duration: 12,
      sourceIn: 0,
      note: "",
    },
  ];
  const save = await page.request.put("/api/workbench/projects", {
    headers,
    data: { project, revision },
  });
  expect(save.ok(), await save.text()).toBe(true);
  await page.goto("/workbench");
  await page.evaluate(({ scope, id }) => localStorage.setItem(scope, id), {
    scope,
    id: project.id,
  });
  await page.reload();
  await stage(page, "edit");
  await openWorkbenchInspector(page, "color");
  const panel = page.getByRole("region", { name: "Sequence look" });
  const input = panel.getByLabel("Import sequence LUT", { exact: true });
  let uploads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/uploads/chunk")) uploads++;
  });
  await input.setInputFiles({
    name: "Incomplete.cube",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("LUT_3D_SIZE 2\n0 0 0"),
  });
  await expect(panel.getByRole("alert")).toContainText("incomplete");
  expect(uploads).toBe(0);
  // Swap red and blue. At 2 points, trilinear interpolation should be exact.
  const cube = `TITLE "Channel swap"\nLUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${(i >> 2) & 1} ${(i >> 1) & 1} ${i & 1}`).join("\n")}\n`;
  await input.setInputFiles({
    name: "Channel swap.cube",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(cube),
  });
  const selected = panel.getByLabel("Sequence LUT", { exact: true });
  await expect(selected).not.toHaveValue("");
  const lutId = await selected.inputValue();
  const preview = page.getByLabel("Graded timeline preview", { exact: true });
  const pixel = () =>
    preview.evaluate((canvas: HTMLCanvasElement) =>
      [
        ...canvas
          .getContext("2d")!
          .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ].slice(0, 3),
    );
  await expect.poll(pixel).toEqual([192, 128, 64]);
  await panel.getByLabel("LUT mix", { exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(preview).toHaveCount(0);
  await panel.getByLabel("LUT mix", { exact: true }).focus();
  await page.keyboard.press("End");
  await expect.poll(pixel).toEqual([192, 128, 64]);
  await panel.getByLabel("Bypass sequence look", { exact: true }).check();
  await expect(preview).toHaveCount(0);
  await panel.getByLabel("Bypass sequence look", { exact: true }).uncheck();
  await expect.poll(pixel).toEqual([192, 128, 64]);
  const read = () =>
    page.request
      .get(
        "/api/workbench/projects?" + new URLSearchParams({ id: project.id }),
        { headers },
      )
      .then((r) => r.json()) as Promise<{ project: Project }>;
  await expect
    .poll(async () => (await read()).project.colorGrade)
    .toEqual({
      lutAssetId: lutId,
      mix: 1,
      brightness: 1,
      contrast: 1,
      saturation: 1,
      bypassed: false,
    });
  await page.reload();
  await stage(page, "edit");
  await openWorkbenchInspector(page, "color");
  await expect(selected).toHaveValue(lutId);
  await expect.poll(pixel).toEqual([192, 128, 64]);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sequence-color.png") });
  const saved = (await read()).project,
    lut = saved.assets.find((a) => a.id === lutId)!;
  expect(
    (await page.request.get(lut.url).then((r) => r.body())).toString(),
  ).toBe(cube);
  await stage(page, "export");
  const packageButton = page.getByRole("button", { name: /Download package/ });
  // A saved .cube is carried as an original, rather than an invented text extension.
  {
    await expect(packageButton).toBeVisible();
    const pending = page.waitForEvent("download");
    await packageButton.click();
    const file = await pending,
      path = info.outputPath("editorial.zip");
    await file.saveAs(path);
    const { unzipSync } = await import("fflate"),
      files = unzipSync(new Uint8Array(await readFile(path)));
    const lutFile = Object.keys(files).find((name) => name.endsWith(".cube"));
    expect(lutFile).toBeTruthy();
    expect(Buffer.from(files[lutFile!]).toString()).toBe(cube);
  }
  await page
    .getByRole("button", { name: "Open movie renderer", exact: true })
    .click();
  await expect(page.getByLabel("Movie format", { exact: true })).toBeEnabled();
  await page.getByLabel("Movie format", { exact: true }).selectOption("webm");
  await page.getByRole("button", { name: "Render movie", exact: true }).click();
  const link = page.getByRole("link", { name: "Download WebM", exact: true });
  await expect(link).toBeVisible({ timeout: 60000 });
  const pending = page.waitForEvent("download");
  await link.click();
  const download = await pending,
    path = info.outputPath("graded.webm");
  await download.saveAs(path);
  await page.route("**/__color-test__/mediabunny.js", (route) =>
    route.fulfill({
      path: "node_modules/mediabunny/dist/bundles/mediabunny.mjs",
      contentType: "text/javascript",
    }),
  );
  const decoded = await page.evaluate(
    async (bytes) => {
      const url = "/__color-test__/mediabunny.js";
      const { Input, BlobSource, ALL_FORMATS, VideoSampleSink } = (await import(
        url
      )) as typeof import("mediabunny");
      const input = new Input({
        source: new BlobSource(new Blob([new Uint8Array(bytes)])),
        formats: ALL_FORMATS,
      });
      try {
        const track = (await input.getPrimaryVideoTrack())!,
          frame = (await new VideoSampleSink(track).getSample(0.1))!;
        const canvas = document.createElement("canvas");
        canvas.width = track.displayWidth;
        canvas.height = track.displayHeight;
        const ctx = canvas.getContext("2d")!;
        frame.draw(ctx, 0, 0);
        frame.close();
        return {
          pixel: [
            ...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
          ].slice(0, 3),
          corner: [...ctx.getImageData(1, 1, 1, 1).data].slice(0, 3),
          duration: await track.computeDuration(),
        };
      } finally {
        input.dispose();
      }
    },
    [...(await readFile(path))],
  );
  decoded.pixel.forEach((value, index) =>
    expect(Math.abs(value - [192, 128, 64][index])).toBeLessThan(5),
  );
  expect(Math.max(...decoded.corner)).toBeLessThan(5);
  expect(decoded.duration).toBeCloseTo(0.5, 3);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
