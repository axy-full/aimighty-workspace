import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
function sine() {
  const frames = 96000,
    b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(96000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.5 * 32767),
      44 + i * 2,
    );
  return b;
}

/**
 * Retargeted from the old Studio's edit stage (retired in Release 1) to Edit & Sound over the board: the Cut card's "Open
 * Edit & Sound", then Mix, which is the same SoundMix. Two things the old stage had that the new one does not: the Studio's
 * playhead slider (the transport's frame is set by clicking the picture lane) and the Studio-wide undo (⌘Z), so the undo
 * assertion is gone with it.
 */
async function openMix(page: Page, projectId: string) {
  await page.goto(`/suites?project=${projectId}&view=board&region=cut`);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  await page.getByTestId("cut-open-edit").click();
  await expect(page.getByTestId("es")).toBeVisible();
  await page.getByTestId("es-tool-mix").click();
  return page.getByRole("region", { name: "Sound mix" });
}

test("sound clips persist, mix at their timeline offsets with pan and fades, and deliver valid uncompressed stereo WAV", async ({
  page,
}, info) => {
  test.skip(!["workbench-1440x900", "workbench-1920x1080"].includes(info.project.name), "the board and its Edit & Sound are the desktop's");
  await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  const session = randomUUID(),
    headers = { "X-Workbench-Scope": scope };
  const chunk = await page.request.post("/api/uploads/chunk", {
    headers,
    multipart: {
      session,
      index: "0",
      chunk: {
        name: "chunk",
        mimeType: "application/octet-stream",
        buffer: sine(),
      },
    },
  });
  expect(chunk.ok(), await chunk.text()).toBe(true);
  const uploaded = await page.request.post("/api/uploads/finish", {
    headers,
    data: {
      session,
      count: 1,
      filename: "Score.wav",
      mime: "audio/wav",
      purpose: "chat",
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const upload = await uploaded.json();
  const partial = await page.request.get(upload.url, {
    headers: { Range: "bytes=44-139" },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"]).toBe(
    `bytes 44-139/${sine().length}`,
  );
  expect(await partial.body()).toEqual(sine().subarray(44, 140));
  const suffix = await page.request.get(upload.url, {
    headers: { Range: "bytes=-64" },
  });
  expect(suffix.status()).toBe(206);
  expect(await suffix.body()).toEqual(sine().subarray(-64));
  expect(
    (
      await page.request.get(upload.url, {
        headers: { Range: "bytes=999999999-" },
      })
    ).status(),
  ).toBe(416);
  const outsider = await page
    .context()
    .browser()!
    .newContext({ baseURL: process.env.PW_BASE_URL });
  try {
    expect(
      (
        await outsider.request.get(
          new URL(upload.url, process.env.PW_BASE_URL).toString(),
          { headers: { Range: "bytes=0-9" } },
        )
      ).status(),
    ).toBe(401);
    await signInLocally(outsider.request);
    expect(
      (
        await outsider.request.get(
          new URL(upload.url, process.env.PW_BASE_URL).toString(),
          { headers: { Range: "bytes=0-9" } },
        )
      ).status(),
    ).toBe(404);
  } finally {
    await outsider.close();
  }
  const p = seedProject();
  p.id = "sound-" + randomUUID().slice(0, 8);
  p.name = "Sound test";
  p.shots = p.shots.slice(0, 1).map((s) => ({ ...s, duration: 72 }));
  p.assets.push({
    ...p.assets[0],
    id: "score",
    name: "Score",
    kind: "audio",
    url: upload.url,
    uploadId: upload.id,
    mime: "audio/wav",
    refs: [],
  });
  const saved = await page.request.put("/api/workbench/projects", {
    headers,
    data: { project: p, revision: 0 },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const read = () =>
    page.request
      .get("/api/workbench/projects?" + new URLSearchParams({ id: p.id }), {
        headers,
      })
      .then((r) => r.json()) as Promise<{ project: Project }>;
  await page.addInitScript(() => {
    const root = window as Window & {
      soundTransport?: { offset: number; duration: number }[];
    };
    root.soundTransport = [];
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      ...args: Parameters<typeof original>
    ) {
      if (this.context instanceof AudioContext)
        root.soundTransport!.push({
          offset: args[1] || 0,
          duration: this.buffer?.duration || 0,
        });
      return original.apply(this, args);
    };
  });
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: p.id });
  let mix = await openMix(page, p.id);
  await mix.getByLabel("Audio source", { exact: true }).selectOption("score");
  await mix
    .getByRole("button", { name: "Add sound clip", exact: true })
    .click();
  const clip = mix.getByRole("group", { name: "Sound clip 1" });
  await clip.getByLabel("Timeline start", { exact: true }).fill("12");
  await clip.getByLabel("Source in", { exact: true }).fill("6");
  await clip.getByLabel("Gain (dB)", { exact: true }).fill("-6");
  await clip.getByLabel("Pan", { exact: true }).fill("-1");
  await clip.getByLabel("Fade in", { exact: true }).fill("6");
  await clip.getByLabel("Fade out", { exact: true }).fill("6");
  await expect
    .poll(async () => (await read()).project.audioClips?.[0])
    .toMatchObject({
      startFrame: 12,
      sourceIn: 6,
      duration: 24,
      gainDb: -6,
      pan: -1,
      fadeIn: 6,
      fadeOut: 6,
    });
  /* Typing a Duration passes through shorter lengths (the "2" of "24"); the fades survive them. */
  const length = clip.getByLabel("Duration", { exact: true });
  await length.fill("");
  await length.pressSequentially("24", { delay: 80 });
  await length.press("Enter");
  await expect(clip.getByLabel("Fade in", { exact: true })).toHaveValue("6");
  await expect(clip.getByLabel("Fade out", { exact: true })).toHaveValue("6");
  await expect
    .poll(async () => (await read()).project.audioClips?.[0])
    .toMatchObject({ duration: 24, fadeIn: 6, fadeOut: 6 });
  /* A gain typed key by key ("-1", then "-12") lands as -12, and typing it back leaves -6. */
  const gain = clip.getByLabel("Gain (dB)", { exact: true });
  await gain.fill("");
  await gain.pressSequentially("-12", { delay: 80 });
  await gain.press("Enter");
  await expect
    .poll(async () => (await read()).project.audioClips?.[0].gainDb)
    .toBe(-12);
  await gain.fill("-6");
  await expect
    .poll(async () => (await read()).project.audioClips?.[0].gainDb)
    .toBe(-6);
  await page.reload();
  mix = await openMix(page, p.id);
  await expect(mix.getByRole("group", { name: "Sound clip 1" }).getByLabel("Gain (dB)", { exact: true })).toHaveValue("-6");
  await mix.getByRole("button", { name: "Prepare mix", exact: true }).click();
  await expect(mix.getByRole("status")).toContainText("Mix ready", {
    timeout: 60000,
  });
  /* The playhead at frame 12 of the 72-frame cut: a click a fifth of a frame past it on the picture lane. */
  const track = page.getByTestId("es-lane-picture").locator(".gx-es-track");
  const box = (await track.boundingBox())!;
  await track.click({ position: { x: (box.width * 12.2) / 72, y: box.height / 2 } });
  await expect(page.getByTestId("es-time")).toContainText("00:00:00:12 /");
  const play = page.getByTestId("es-play");
  await play.focus();
  await play.press("Space");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & {
            soundTransport?: { offset: number; duration: number }[];
          }
        ).soundTransport?.at(0),
      ),
    )
    .toMatchObject({ offset: 0.5, duration: 3 });
  await play.click();
  await expect(play).toHaveText("Play");
  const download = page.waitForEvent("download");
  await mix
    .getByRole("button", { name: "WAV · 24-bit PCM", exact: true })
    .click();
  const pcm = await readFile((await (await download).path())!);
  expect(pcm.readUInt16LE(20)).toBe(1);
  expect(pcm.readUInt16LE(22)).toBe(2);
  expect(pcm.readUInt32LE(24)).toBe(48000);
  expect(pcm.readUInt16LE(34)).toBe(24);
  expect(pcm.length).toBe(44 + 3 * 48000 * 6);
  const rms = (from: number, to: number, ch: number) => {
    let sum = 0,
      count = 0;
    for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i++) {
      const at = 44 + i * 6 + ch * 3;
      let n = pcm[at] | (pcm[at + 1] << 8) | (pcm[at + 2] << 16);
      if (n & 0x800000) n -= 0x1000000;
      sum += (n / 8388608) ** 2;
      count++;
    }
    return Math.sqrt(sum / count);
  };
  expect(rms(0, 0.49, 0)).toBe(0);
  expect(rms(0.8, 1, 0)).toBeGreaterThan(0.1);
  expect(rms(0.8, 1, 1)).toBeLessThan(0.001);
  expect(rms(0.5, 0.55, 0)).toBeLessThan(rms(0.8, 1, 0) / 3);
  expect(rms(1.6, 2.9, 0)).toBe(0);
  const floatDownload = page.waitForEvent("download");
  await mix
    .getByRole("button", { name: "WAV · 32-bit float", exact: true })
    .click();
  const floats = await readFile((await (await floatDownload).path())!);
  expect(floats.readUInt16LE(20)).toBe(3);
  expect(floats.toString("ascii", 36, 40)).toBe("fact");
  expect(floats.length).toBe(56 + 3 * 48000 * 8);
  await clip.getByLabel("Gain (dB)", { exact: true }).fill("-3");
  await expect(
    mix.getByRole("button", { name: "WAV · 24-bit PCM", exact: true }),
  ).toBeDisabled();
  await clip.getByLabel("Duration", { exact: true }).fill("72");
  await mix.getByRole("button", { name: "Prepare mix", exact: true }).click();
  await expect(mix.getByRole("alert")).toContainText("extends past");
  await clip.getByLabel("Duration", { exact: true }).fill("24");
  await mix.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sound-mix.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
