import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import sharp from "sharp";

// Exercise the shipped browser decoder itself, with a real MP4 and no provider.
for (const mediaUrl of ["/api/uploads/clip", "/api/media/clip"]) {
  test(
    "Atomik decodes three real stills through same-origin media: " + mediaUrl,
    async ({ page }) => {
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
        .outputText.replace('"./atomik-reference-types"', '"/types.js"');
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
      const result = await page.evaluate(async (mediaUrl) => {
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
