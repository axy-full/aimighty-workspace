import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project, type Asset } from "../lib/workbench/studio";

const moduleUrl = "/__movie-test__/mediabunny.js";
async function openDelivery(page: Page) {
  if (new URL(page.url()).pathname === "/workbench/movie")
    await page.goto("/workbench");
  if (page.viewportSize()!.width < 760) {
    await page
      .getByRole("navigation", { name: "Mobile studio navigation" })
      .getByRole("button", { name: "Workflow", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Production workflow" })
      .getByRole("button", { name: /10 Delivery/ })
      .click();
  } else await page.locator(".workflow-stages").getByRole("tab").last().click();
  await page
    .getByRole("button", { name: "Open movie renderer", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workbench\/movie\?snapshot=/);
  await expect(
    page.getByRole("heading", { name: "Final movie", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Movie format", { exact: true })).toBeEnabled();
  // Turbopack itself needs eval during hydration. Restrict the document before
  // any media encoding or worker is created; production receives this policy from Next.
  await page.evaluate(() => {
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content =
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:";
    document.head.append(policy);
  });
}
function sineWav(seconds: number, frequency: number) {
  const samples = seconds * 48000,
    buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(96000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    buffer.writeInt16LE(
      Math.round(
        (i >= 12000 && i < 12048
          ? 0.8
          : Math.sin((i * 2 * Math.PI * frequency) / 48000) * 0.2) * 32767,
      ),
      44 + i * 2,
    );
  return buffer;
}
async function movieFixture(page: Page) {
  if (process.env.PW_MOVIE_PRODUCTION_SETUP === "1") {
    const base = process.env.PW_BASE_URL || "";
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))
      throw new Error("Production movie fixture requires localhost.");
    const health = await page.request
      .get("/api/health")
      .then((response) => response.json());
    expect(health.mock).toBe(true);
    const credentials = {
      email: "movie-production@example.test",
      name: "Production movie test",
      password: "local production movie fixture 42",
    };
    const setup = await page.request.post("/api/auth/setup", {
      data: credentials,
    });
    expect([200, 403]).toContain(setup.status());
    const login = await page.request.post("/api/auth/login", {
      data: credentials,
    });
    expect(login.ok(), await login.text()).toBe(true);
  } else await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  let project: Project = newProject("Synthetic movie");
  project.aspect = "9:16";
  const media = new Map<string, { body: Buffer; type: string }>();
  const mutations: string[] = [];
  await page.route(`**${moduleUrl}`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      path: "node_modules/mediabunny/dist/bundles/mediabunny.mjs",
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (request.method() !== "GET") {
      mutations.push(path);
      if (path === "/api/workbench/projects" && request.method() === "PUT") {
        project = request.postDataJSON().project;
        return json({ revision: 2 });
      }
      throw new Error(
        `Unexpected paid/mutating request during local encoding: ${path}`,
      );
    }
    if (path === "/api/workbench/projects")
      return json({
        project,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
        revision: 1,
      });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/jobs") return json({ generations: [] });
    const item = media.get(path);
    if (item) {
      const requested = request.headers()["range"];
      const match = requested?.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = Number(match[1]),
          end = Math.min(
            match[2] ? Number(match[2]) : item.body.length - 1,
            item.body.length - 1,
          );
        return route.fulfill({
          status: 206,
          headers: {
            "Content-Type": item.type,
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${item.body.length}`,
            "Content-Length": String(end - start + 1),
          },
          body: item.body.subarray(start, end + 1),
        });
      }
      return route.fulfill({
        body: item.body,
        contentType: item.type,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": String(item.body.length),
        },
      });
    }
    if (path.startsWith("/api/workbench/preview/"))
      return route.fulfill({
        body: await readFile("public/campaign/hero.webp"),
        contentType: "image/webp",
      });
    throw new Error(`Unexpected source read: ${path}`);
  });
  await page.goto("/workbench");
  const fixture = await page.evaluate(async (url) => {
    const {
      Output,
      BufferTarget,
      CanvasSource,
      AudioBufferSource,
      Quality,
      WebMOutputFormat,
    } = (await import(url)) as typeof import("mediabunny");
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 160;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 320, 160);
    const image = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/png"),
    );
    const target = new BufferTarget(),
      output = new Output({ target, format: new WebMOutputFormat() });
    const video = new CanvasSource(canvas, {
      codec: "vp9",
      quality: new Quality({ bitrate: 800000 }),
    });
    const audio = new AudioBufferSource({
      codec: "opus",
      quality: new Quality({ bitrate: 128000 }),
    });
    output.addVideoTrack(video, { frameRate: 24 });
    output.addAudioTrack(audio);
    await output.start();
    const tone = new AudioBuffer({
      numberOfChannels: 1,
      sampleRate: 48000,
      length: 96000,
    });
    const channel = tone.getChannelData(0);
    for (let i = 0; i < channel.length; i++)
      channel[i] = Math.sin((i * 2 * Math.PI * 880) / 48000) * 0.2;
    await audio.add(tone);
    audio.close();
    for (let frame = 0; frame < 48; frame++) {
      ctx.fillStyle = frame < 12 ? "blue" : frame < 24 ? "lime" : "yellow";
      ctx.fillRect(0, 0, 320, 160);
      await video.add(frame / 24, 1 / 24);
    }
    video.close();
    await output.finalize();
    return {
      image: [...new Uint8Array(await image.arrayBuffer())],
      video: [...new Uint8Array(target.buffer!)],
    };
  }, moduleUrl);
  media.set("/api/uploads/still", {
    body: Buffer.from(fixture.image),
    type: "image/png",
  });
  media.set("/api/uploads/video", {
    body: Buffer.from(fixture.video),
    type: "video/webm",
  });
  media.set("/api/uploads/soundtrack", {
    body: sineWav(2, 440),
    type: "audio/wav",
  });
  const asset = (id: string, kind: Asset["kind"]): Asset => ({
    id,
    kind,
    name: `Synthetic ${id}`,
    category: "Test",
    url: `/api/uploads/${id}`,
    uploadId: id,
    description: "Synthetic test media",
    prompt: "",
    status: "Selected",
    locked: false,
    version: 1,
    refs: [],
  });
  project = {
    ...project,
    assets: [
      asset("still", "image"),
      asset("video", "video"),
      asset("soundtrack", "audio"),
    ],
    audioAssetId: "soundtrack",
    shots: [
      {
        id: "hold",
        name: "Red still",
        assetId: "still",
        sourceIn: 0,
        duration: 12,
        note: "",
      },
      {
        id: "trim",
        name: "Trimmed video",
        assetId: "video",
        sourceIn: 12,
        duration: 24,
        note: "",
      },
    ],
  };
  await page.reload();
  await openDelivery(page);
  return {
    setProject: (update: (current: Project) => Project) => {
      project = update(project);
    },
    mutations,
  };
}

test("timeline scrubbing and the final movie use the same saved multitrack stereo mix as WAV", async ({
  page,
}, info) => {
  test.skip(
    page.viewportSize()!.width !== 1440,
    "Detailed codec comparison runs once; responsive sound controls run at every size.",
  );
  const fixture = await movieFixture(page);
  fixture.setProject((p) => ({
    ...p,
    audioAssetId: undefined,
    clipAudio: false,
    audioClips: [
      {
        id: "score",
        assetId: "soundtrack",
        lane: "music",
        startFrame: 12,
        sourceIn: 0,
        duration: 12,
        gainDb: -3,
        pan: -1,
        fadeIn: 0,
        fadeOut: 0,
        muted: false,
        solo: false,
      },
      {
        id: "muted",
        assetId: "soundtrack",
        lane: "sfx",
        startFrame: 0,
        sourceIn: 0,
        duration: 24,
        gainDb: 0,
        pan: 1,
        fadeIn: 0,
        fadeOut: 0,
        muted: true,
        solo: false,
      },
    ],
  }));
  await page.goto("/workbench");
  await page.locator(".workflow-stages").getByRole("tab").nth(8).click();
  const playhead = page.getByRole("slider", { name: "Sequence playhead" });
  await playhead.focus();
  await playhead.press("End");
  const video = page.getByLabel("Timeline video preview", { exact: true });
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeCloseTo(35 / 24, 2);
  const color = await video.evaluate((el: HTMLVideoElement) => {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(el, 0, 0, 16, 16);
    return [...ctx.getImageData(8, 8, 1, 1).data];
  });
  expect(color[0]).toBeGreaterThan(200);
  expect(color[1]).toBeGreaterThan(200);
  const mix = page.getByRole("region", { name: "Sound mix" });
  await mix.getByRole("button", { name: "Prepare mix", exact: true }).click();
  await expect(mix.getByRole("status")).toContainText("Mix ready");
  const wavDownload = page.waitForEvent("download");
  await mix
    .getByRole("button", { name: "WAV · 32-bit float", exact: true })
    .click();
  const wav = await readFile((await (await wavDownload).path())!);
  await openDelivery(page);
  await expect(
    page.getByRole("checkbox", {
      name: "Include original clip audio",
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByLabel("Movie format", { exact: true }).selectOption("webm");
  await page.getByRole("button", { name: "Render movie", exact: true }).click();
  const link = page.getByRole("link", { name: "Download WebM", exact: true });
  await expect(link).toBeVisible({ timeout: 60000 });
  const download = page.waitForEvent("download");
  await link.click();
  const encoded = await readFile((await (await download).path())!);
  const compare = await page.evaluate(
    async ({ encoded, wav, url }) => {
      const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = (await import(
        url
      )) as typeof import("mediabunny");
      const input = new Input({
        source: new BlobSource(new Blob([new Uint8Array(encoded)])),
        formats: ALL_FORMATS,
      });
      try {
        const track = (await input.getPrimaryAudioTrack())!;
        const pcm = [new Float32Array(72000), new Float32Array(72000)];
        for await (const { buffer, timestamp } of new AudioBufferSink(
          track,
        ).buffers()) {
          for (let ch = 0; ch < 2; ch++) {
            const samples = buffer.getChannelData(ch);
            for (let i = 0; i < samples.length; i++) {
              const n = Math.round(timestamp * 48000) + i;
              if (n >= 0 && n < 72000) pcm[ch][n] = samples[i];
            }
          }
        }
        const original = new DataView(new Uint8Array(wav).buffer);
        let error = 0,
          energy = 0,
          right = 0,
          before = 0;
        for (let i = 0; i < 72000; i++) {
          for (let ch = 0; ch < 2; ch++)
            error +=
              (pcm[ch][i] - original.getFloat32(56 + i * 8 + ch * 4, true)) **
              2;
          energy += pcm[0][i] ** 2;
          right += pcm[1][i] ** 2;
          if (i < 20000) before += pcm[0][i] ** 2;
        }
        return {
          error: Math.sqrt(error / 144000),
          left: Math.sqrt(energy / 72000),
          right: Math.sqrt(right / 72000),
          before: Math.sqrt(before / 20000),
        };
      } finally {
        input.dispose();
      }
    },
    { encoded: [...encoded], wav: [...wav], url: moduleUrl },
  );
  expect(compare.error).toBeLessThan(0.02);
  expect(compare.left).toBeGreaterThan(0.04);
  expect(compare.right).toBeLessThan(0.001);
  expect(compare.before).toBeLessThan(0.001);
  await page.screenshot({ path: info.outputPath("sound-movie-parity.png") });
});

test("encoded final movie preserves frames, trims, aspect and synchronized clip/soundtrack audio", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await movieFixture(page);
  await page.getByLabel("Movie format", { exact: true }).selectOption("webm");
  await page.getByRole("button", { name: "Render movie", exact: true }).click();
  const link = page.getByRole("link", { name: "Download WebM", exact: true });
  await expect(link).toBeVisible({ timeout: 60000 });
  const download = page.waitForEvent("download");
  await link.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Synthetic_movie_720x1280_24fps.webm");
  const outputPath = testInfo.outputPath("synthetic-final.webm");
  await file.saveAs(outputPath);
  const encoded = [...(await readFile(outputPath))];
  const inspection = await page.evaluate(
    async ({ encoded, source }) => {
      const {
        Input,
        BlobSource,
        ALL_FORMATS,
        VideoSampleSink,
        AudioBufferSink,
      } = (await import(source)) as typeof import("mediabunny");
      const input = new Input({
        source: new BlobSource(new Blob([new Uint8Array(encoded)])),
        formats: ALL_FORMATS,
      });
      try {
        const video = (await input.getPrimaryVideoTrack())!,
          audio = (await input.getPrimaryAudioTrack())!;
        const sink = new VideoSampleSink(video);
        let frames = 0;
        for await (const sample of sink.samples()) {
          frames++;
          sample.close();
        }
        const canvas = document.createElement("canvas");
        canvas.width = video.displayWidth;
        canvas.height = video.displayHeight;
        const ctx = canvas.getContext("2d")!;
        const colors = [];
        for (const timestamp of [0.25, 0.49, 0.5, 0.75, 1, 1.25]) {
          const sample = (await sink.getSample(timestamp))!;
          sample.draw(ctx, 0, 0);
          sample.close();
          colors.push(
            [
              ...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1)
                .data,
            ].slice(0, 3),
          );
        }
        const corner = [...ctx.getImageData(10, 10, 1, 1).data].slice(0, 3);
        const pcm = new Float32Array(96000);
        for await (const item of new AudioBufferSink(audio).buffers()) {
          const samples = item.buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) {
            const index = Math.round(item.timestamp * 48000) + i;
            if (index >= 0 && index < pcm.length) pcm[index] = samples[i];
          }
        }
        const energy = (frequency: number, start: number, end: number) => {
          let sin = 0,
            cos = 0;
          const first = Math.round(start * 48000),
            last = Math.round(end * 48000);
          for (let i = first; i < last; i++) {
            const phase = (i * 2 * Math.PI * frequency) / 48000;
            sin += pcm[i] * Math.sin(phase);
            cos += pcm[i] * Math.cos(phase);
          }
          return (2 * Math.hypot(sin, cos)) / (last - first);
        };
        return {
          frames,
          duration: await video.computeDuration(),
          width: canvas.width,
          height: canvas.height,
          colors,
          corner,
          soundtrackBefore: energy(440, 0.1, 0.4),
          clipBefore: energy(880, 0.1, 0.4),
          soundtrackDuring: energy(440, 0.7, 1.3),
          clipDuring: energy(880, 0.7, 1.3),
        };
      } finally {
        input.dispose();
      }
    },
    { encoded, source: moduleUrl },
  );
  expect(inspection.frames).toBe(36);
  expect(inspection.duration).toBeCloseTo(1.5, 3);
  expect([inspection.width, inspection.height]).toEqual([720, 1280]);
  for (const index of [0, 1]) {
    expect(inspection.colors[index][0]).toBeGreaterThan(200);
    expect(inspection.colors[index][1]).toBeLessThan(30);
  }
  for (const index of [2, 3]) {
    expect(inspection.colors[index][1]).toBeGreaterThan(200);
    expect(inspection.colors[index][0]).toBeLessThan(30);
  }
  for (const index of [4, 5]) {
    expect(inspection.colors[index][0]).toBeGreaterThan(200);
    expect(inspection.colors[index][1]).toBeGreaterThan(200);
  }
  expect(Math.max(...inspection.corner)).toBeLessThan(20);
  expect(inspection.soundtrackBefore).toBeGreaterThan(0.1);
  expect(inspection.clipBefore).toBeLessThan(0.01);
  expect(inspection.soundtrackDuring).toBeGreaterThan(0.1);
  expect(inspection.clipDuring).toBeGreaterThan(0.1);
  expect(
    fixture.mutations.filter((path) => path !== "/api/workbench/projects"),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  const preview = page.getByLabel("Rendered final movie", { exact: true });
  await expect
    .poll(() => preview.evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(2);
  await preview.evaluate((video: HTMLVideoElement) => {
    video.currentTime = 0.75;
  });
  await expect
    .poll(() => preview.evaluate((video: HTMLVideoElement) => video.seeking))
    .toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("movie-delivery.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("movie export rejects a video trim beyond its source instead of freezing missing frames", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "workbench-1440x900",
    "One source-boundary regression.",
  );
  const fixture = await movieFixture(page);
  fixture.setProject((project) => ({
    ...project,
    shots: project.shots.map((shot) =>
      shot.assetId === "video" ? { ...shot, sourceIn: 48 } : shot,
    ),
  }));
  await page.reload();
  await openDelivery(page);
  await page.getByLabel("Movie format", { exact: true }).selectOption("webm");
  await page.getByRole("button", { name: "Render movie", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "runs past the end" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Download WebM" })).toHaveCount(
    0,
  );
});

test("movie format encodes a cropped silent file and cancellation discards an unfinished download", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "workbench-1440x900",
    "One alternate-codec and cancellation regression.",
  );
  await movieFixture(page);
  const formats = page.getByLabel("Movie format", { exact: true });
  await expect(formats).toBeEnabled();
  const format = (await formats.locator('option[value="mp4"]').count())
    ? "mp4"
    : "webm";
  await formats.selectOption(format);
  await page.getByLabel("Movie framing", { exact: true }).selectOption("cover");
  await page
    .getByRole("checkbox", { name: "Include original clip audio", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Include saved sound mix", exact: true })
    .uncheck();
  let startFetch!: () => void;
  const fetching = new Promise<void>((resolve) => {
    startFetch = resolve;
  });
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  await page.route(
    "**/api/uploads/still",
    async (route) => {
      startFetch();
      await blocked;
      await route.fallback().catch(() => {});
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Render movie", exact: true }).click();
  await fetching;
  await page
    .getByRole("button", { name: "Cancel movie render", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Render movie", exact: true }),
  ).toBeVisible();
  unblock();
  await expect(
    page.getByRole("link", { name: /^Download (MP4|WebM)$/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Render movie", exact: true }).click();
  const link = page.getByRole("link", {
    name: format === "mp4" ? "Download MP4" : "Download WebM",
    exact: true,
  });
  await expect(link).toBeVisible({ timeout: 60000 });
  const download = page.waitForEvent("download");
  await link.click();
  const file = await download;
  const path = testInfo.outputPath(`synthetic-cropped-silent.${format}`);
  await file.saveAs(path);
  const inspection = await page.evaluate(
    async ({ encoded, source }) => {
      const { Input, BlobSource, ALL_FORMATS, VideoSampleSink } = (await import(
        source
      )) as typeof import("mediabunny");
      const input = new Input({
        source: new BlobSource(new Blob([new Uint8Array(encoded)])),
        formats: ALL_FORMATS,
      });
      try {
        const video = (await input.getPrimaryVideoTrack())!;
        const sample = (await new VideoSampleSink(video).getSample(0.25))!;
        const canvas = document.createElement("canvas");
        canvas.width = video.displayWidth;
        canvas.height = video.displayHeight;
        const ctx = canvas.getContext("2d")!;
        sample.draw(ctx, 0, 0);
        sample.close();
        return {
          audio: (await input.getAudioTracks()).length,
          duration: await video.computeDuration(),
          corner: [...ctx.getImageData(10, 10, 1, 1).data].slice(0, 3),
          codec: await video.getCodec(),
        };
      } finally {
        input.dispose();
      }
    },
    { encoded: [...(await readFile(path))], source: moduleUrl },
  );
  expect(inspection.audio).toBe(0);
  expect(inspection.duration).toBeCloseTo(1.5, 3);
  expect(inspection.corner[0]).toBeGreaterThan(200);
  expect(inspection.corner[1]).toBeLessThan(30);
  if (format === "mp4") expect(inspection.codec).toBe("avc");
  else expect(["vp9", "vp8"]).toContain(inspection.codec);
  if (format === "mp4") {
    await page
      .getByRole("checkbox", {
        name: "Include saved sound mix",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Render movie", exact: true })
      .click();
    await expect(link).toBeVisible({ timeout: 60000 });
    const audioDownload = page.waitForEvent("download");
    await link.click();
    const audioFile = await audioDownload;
    const audioPath = testInfo.outputPath("synthetic-aac.mp4");
    await audioFile.saveAs(audioPath);
    const audioInspection = await page.evaluate(
      async ({ encoded, source }) => {
        const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } =
          (await import(source)) as typeof import("mediabunny");
        const input = new Input({
          source: new BlobSource(new Blob([new Uint8Array(encoded)])),
          formats: ALL_FORMATS,
        });
        try {
          const track = (await input.getPrimaryAudioTrack())!;
          let energy = 0,
            count = 0,
            peak = 0,
            peakTime = 0;
          for await (const { buffer, timestamp } of new AudioBufferSink(
            track,
          ).buffers()) {
            let index = 0;
            for (const sample of buffer.getChannelData(0)) {
              if (Math.abs(sample) > peak) {
                peak = Math.abs(sample);
                peakTime = timestamp + index / buffer.sampleRate;
              }
              index++;
              energy += sample * sample;
              count++;
            }
          }
          return {
            codec: await track.getCodec(),
            duration: await track.computeDuration(),
            rms: Math.sqrt(energy / count),
            peakTime,
          };
        } finally {
          input.dispose();
        }
      },
      { encoded: [...(await readFile(audioPath))], source: moduleUrl },
    );
    expect(audioInspection.codec).toBe("aac");
    expect(audioInspection.duration).toBeCloseTo(1.5, 3);
    expect(Math.abs(audioInspection.peakTime - 0.2505)).toBeLessThan(0.003);
    expect(audioInspection.rms).toBeGreaterThan(0.1);
  }
});

test("movie snapshot does not reveal the outgoing production after an account switch", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "workbench-1440x900",
    "One real account boundary regression.",
  );
  await movieFixture(page);
  await expect(
    page.getByRole("heading", { name: "Synthetic movie", exact: true }),
  ).toBeVisible();
  await signInLocally(page.request);
  await page.reload();
  await expect(page.getByRole("status")).toContainText(
    "another account or workspace",
  );
  await expect(
    page.getByRole("heading", { name: "Synthetic movie", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Render movie", exact: true }),
  ).toHaveCount(0);
  const normal = await page.request.get("/workbench");
  expect(normal.headers()["content-security-policy"]).not.toContain(
    "wasm-unsafe-eval",
  );
  const exportResponse = await page.request.get(page.url());
  expect(exportResponse.headers()["content-security-policy"]).toContain(
    "worker-src 'self' blob:",
  );
});
