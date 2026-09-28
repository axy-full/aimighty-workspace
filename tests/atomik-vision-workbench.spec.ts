import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import sharp from "sharp";

/** The shipped sampler, compiled as it is, on a page whose media and still
 * uploads are answered here: nothing reaches a server or a provider. */
async function openSampler(page: Page) {
  const posts: { scope?: string; url: string; bytes: Buffer }[] = [];
  const mediaRequests: string[] = [];
  const clip = await readFile("public/fixtures/clip.mp4");
  const compiled = ts
    .transpileModule(
      await readFile("lib/workbench/atomik-video-frames.ts", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      },
    )
    .outputText.replace('"./atomik-reference-types"', '"/types.js"')
    .replace('"./media-reference-input"', '"/media-reference.js"');
  const mediaReference = ts.transpileModule(
    await readFile("lib/workbench/media-reference-input.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const types = ts.transpileModule(
    await readFile("lib/workbench/atomik-reference-types.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  await page.route("http://atomik.test/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === "/frames.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: compiled,
      });
    if (url.pathname === "/types.js")
      return route.fulfill({ contentType: "text/javascript", body: types });
    if (url.pathname === "/media-reference.js")
      return route.fulfill({ contentType: "text/javascript", body: mediaReference });
    if (
      url.pathname === "/api/uploads/clip" ||
      url.pathname === "/api/media/clip"
    ) {
      mediaRequests.push(request.url());
      if (
        url.pathname === "/api/media/clip" &&
        url.searchParams.get("stream") !== "1"
      )
        return route.fulfill({
          status: 302,
          headers: { Location: "http://private-cdn.test/clip.mp4" },
        });
      return route.fulfill({ contentType: "video/mp4", body: clip });
    }
    if (url.pathname === "/api/workbench/atomik/frames") {
      posts.push({
        scope: request.headers()["x-workbench-scope"],
        url: request.url(),
        bytes: request.postDataBuffer()!,
      });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: "frame-" + posts.length }),
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Atomik video regression</title>",
    });
  });
  await page.route("http://private-cdn.test/**", (route) =>
    route.fulfill({ contentType: "video/mp4", body: clip }),
  );
  await page.goto("http://atomik.test/");
  return { posts, mediaRequests };
}

const prepare = (page: Page, mediaUrl: string) =>
  page.evaluate(async (mediaUrl) => {
    const load = Function('return import("/frames.js")');
    const { prepareAtomikVideoFrames } = await load();
    return await prepareAtomikVideoFrames(
      [
        {
          id: "video",
          name: "Source clip",
          kind: "video",
          url: mediaUrl,
        },
      ],
      "draft",
      "authenticated-scope",
      new AbortController().signal,
    );
  }, mediaUrl);

// Exercise the shipped browser decoder itself, with a real MP4 and no provider.
for (const mediaUrl of ["/api/uploads/clip", "/api/media/clip"]) {
  test(
    "Atomik decodes three real stills through same-origin media: " + mediaUrl,
    async ({ page }) => {
      const { posts, mediaRequests } = await openSampler(page);
      const result = await prepare(page, mediaUrl);
      expect(mediaRequests.length).toBeGreaterThan(0);
      expect(
        mediaRequests.every(
          (url) => new URL(url).origin === "http://atomik.test",
        ),
      ).toBe(true);
      if (mediaUrl.startsWith("/api/media/"))
        expect(
          mediaRequests.every(
            (url) => new URL(url).searchParams.get("stream") === "1",
          ),
        ).toBe(true);
      expect(result).toHaveLength(3);
      expect(posts).toHaveLength(3);
      expect(
        result.map((frame: { uploadId: string }) => frame.uploadId),
      ).toEqual(["frame-1", "frame-2", "frame-3"]);
      expect(result[0].timeSeconds).toBeLessThan(result[1].timeSeconds);
      expect(result[1].timeSeconds).toBeLessThan(result[2].timeSeconds);
      for (const post of posts) {
        expect(post.scope).toBe("authenticated-scope");
        expect(post.url).toContain("assetId=video");
        const metadata = await sharp(post.bytes).metadata();
        expect(metadata.format).toBe("jpeg");
        expect(metadata.width).toBeLessThanOrEqual(512);
        expect(metadata.height).toBeLessThanOrEqual(512);
        expect(
          (await sharp(post.bytes).raw().toBuffer()).some((value) => value > 0),
        ).toBe(true);
      }
      const errors = await page.evaluate(async () => {
        const { sampleAtomikVideo } = await Function(
          'return import("/frames.js")',
        )();
        const cancelled = new AbortController();
        cancelled.abort();
        const rejected = [];
        for (const [url, signal] of [
          ["https://external.test/private.mp4", new AbortController().signal],
          ["/api/uploads/clip", cancelled.signal],
        ] as const) {
          try {
            await sampleAtomikVideo({ name: "Unsafe", url }, signal);
          } catch (error) {
            rejected.push((error as Error).message);
          }
        }
        return rejected;
      });
      expect(errors).toHaveLength(2);
      expect(posts).toHaveLength(3);
    },
  );
}

/* Chromium can fire `seeked` before the decoded picture has reached the
   element, and a canvas draw then paints nothing: CI once posted the first of
   three stills black. Here the page keeps the picture from the first two draws
   after each seek, as the element does while it has none yet. */
test("a still drawn before the video element has its picture is drawn again, never posted black", async ({ page }) => {
  const { posts } = await openSampler(page);
  const hold = (draws: number) =>
    page.evaluate((draws) => {
      const w = window as typeof window & { __held?: number; __drawn?: number };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
      let sinceSeek = 0;
      w.__held = 0;
      w.__drawn = 0;
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        ...time,
        set(this: HTMLMediaElement, value: number) {
          sinceSeek = 0;
          time.set!.call(this, value);
        },
      });
      CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        if (args[0] instanceof HTMLVideoElement) {
          if (sinceSeek < draws) {
            sinceSeek += 1;
            w.__held! += 1;
            return;
          }
          w.__drawn! += 1;
        }
        return (draw as (...a: unknown[]) => void).apply(this, args);
      } as typeof draw;
    }, draws);
  const counts = () =>
    page.evaluate(() => {
      const w = window as typeof window & { __held?: number; __drawn?: number };
      return { held: w.__held, drawn: w.__drawn };
    });

  await hold(2);
  const result = await prepare(page, "/api/uploads/clip");
  expect(result).toHaveLength(3);
  expect(posts).toHaveLength(3);
  for (const post of posts)
    expect(
      (await sharp(post.bytes).raw().toBuffer()).some((value) => value > 0),
      "a still with a picture",
    ).toBe(true);
  /* Each still was drawn a third time, once the element had its picture. */
  expect(await counts()).toEqual({ held: 6, drawn: 3 });

  /* A picture that never comes is said, and nothing is posted for it. The
     stills just saved are forgotten first, or they would be reused. */
  await page.reload();
  await page.evaluate(() => localStorage.clear());
  await hold(Number.POSITIVE_INFINITY);
  const refused = await prepare(page, "/api/uploads/clip").then(
    () => "prepared",
    (error: Error) => error.message,
  );
  expect(refused).toContain("This browser cannot decode the selected video.");
  expect(posts).toHaveLength(3);
});
