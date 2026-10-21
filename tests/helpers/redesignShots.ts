import type { Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { sizeTag } from "./ownerSizes";

/*
 * Screenshots of a built screen beside the prototype URL it matches (docs/redesign-plan.md › "Screenshots").
 *
 * The prototype (design/particl-prototype-15) is served from a local static server started here, never from the
 * network: requests to any other host are refused, except Google Fonts (the prototype falls back to the system
 * stack without them), so the stand-in stills load from the prototype's own assets/ folder.
 * Output: <REDESIGN_SHOTS_DIR or ../redesign-shots>/<name>/<tag>-{app,proto,beside}.png, where <tag> is 1920x1080, or 2560x1440@2x at a
 * pixel ratio of 2 (the Studio and Pro Displays, tests/helpers/ownerSizes.ts). At a pixel ratio above 1 the PNGs are in device pixels (a
 * 3008x1692 viewport at 2 is 6016x3384), the side-by-side is a WebP only (its PNG would be 12000 px wide), and every shot also gets a
 * downscaled -{app,proto,beside}.webp, the file a PR table shows; the PNG stays for pixel-checking.
 */
/** The width a PR-table WebP is downscaled to (a side-by-side gets two of them). */
export const TABLE_WEBP_WIDTH = 1600;

/* REDESIGN_PROTOTYPE_DIR points at another round of the prototype; the default is the repo's own design, v15 (v12 is kept beside it as the reference). */
const ROOT = path.resolve(process.env.REDESIGN_PROTOTYPE_DIR ?? path.join(__dirname, "../../design/particl-prototype-15"));
/* REDESIGN_PROTOTYPE_PAGE picks the page of that folder: v25 has the app ("Particl prototype.dc.html", the default) and the board ("Particl board.dc.html") as two pages. */
const PAGE = process.env.REDESIGN_PROTOTYPE_PAGE ?? "Particl prototype.dc.html";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webp": "image/webp", ".css": "text/css", ".txt": "text/plain" };

let served: { server: Server; origin: string } | null = null;

async function prototypeOrigin(): Promise<string> {
  if (served) return served.origin;
  const server = createServer(async (req, res) => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname); }
    catch { res.writeHead(400).end(); return; }
    const file = path.resolve(ROOT, "." + pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = (server.address() as { port: number }).port;
  served = { server, origin: `http://127.0.0.1:${port}` };
  return served.origin;
}

export async function closePrototypeServer(): Promise<void> {
  if (!served) return;
  await new Promise((resolve) => served!.server.close(resolve));
  served = null;
}

/** The prototype's URL for a query such as "?view=board&stage=Shots". */
export async function prototypeUrl(query: string): Promise<string> {
  return `${await prototypeOrigin()}/${encodeURIComponent(PAGE)}${query.startsWith("?") || !query ? query : `?${query}`}`;
}

/** Opens the prototype at `query` in `page` (offline) and waits for it to render. */
export async function openPrototype(page: Page, query: string): Promise<void> {
  const origin = await prototypeOrigin();
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return route.continue();
    /* The three Dune Studies stills come from the prototype's own copies, never from particl.app. */
    const still = /^\/campaign\/(hero|environment|character)\.webp$/.exec(url.pathname);
    if (still && /(^|\.)particl\.app$/.test(url.hostname)) return route.fulfill({ path: path.join(ROOT, "assets", `${still[1]}.webp`), contentType: "image/webp" });
    return route.abort();
  });
  await page.goto(await prototypeUrl(query), { waitUntil: "load" });
  /* The prototype compiles its React source in the page (Babel): wait for the app root to have content. */
  await page.waitForFunction(() => (document.querySelector("#root, #dc-root, [data-dc-root], body > div")?.textContent ?? "").trim().length > 20, null, { timeout: 30_000 });
  await page.waitForTimeout(800);
}

/**
 * Writes the app screenshot (the page as it is now), the prototype screenshot (opened in a second page of the same
 * context) and one image with both side by side, app on the left. `prepare` sets the prototype's state that no URL
 * reaches (a right-click menu) before its screenshot.
 */
/**
 * `phone`: the prototype draws its phone screens (`device=phone`) as a 390 × 844 shell centred on a desktop page, so the
 * app's phone-sized page is put beside that shell, cut from the prototype opened at 1440 × 900.
 */
export async function captureBeside(appPage: Page, name: string, protoQuery: string, arg: ((proto: Page) => Promise<void>) | { phone?: boolean; prepare?: (proto: Page) => Promise<void> } = {}): Promise<{ dir: string; files: string[] }> {
  const options = typeof arg === "function" ? { prepare: arg } : arg;
  const phone = Boolean((options as { phone?: boolean }).phone);
  const size = appPage.viewportSize() ?? { width: 1440, height: 900 };
  /* The pixel ratio the page is drawn at: the screenshots are in device pixels, so the side-by-side canvas is too. */
  const dpr = await appPage.evaluate(() => window.devicePixelRatio);
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", name);
  await mkdir(dir, { recursive: true });
  const tag = sizeTag(size.width, size.height, dpr);
  const app = await appPage.screenshot({ animations: "disabled" });
  const proto = await appPage.context().newPage();
  try {
    /* The same size as the app's page, which a phone capture sets itself (page.setViewportSize). */
    await proto.setViewportSize(phone ? { width: 1440, height: 900 } : size);
    await openPrototype(proto, protoQuery);
    if (options.prepare) { await options.prepare(proto); await proto.waitForTimeout(400); }
    const protoShot = await proto.screenshot({ animations: "disabled", ...(phone ? { clip: { x: (1440 - size.width) / 2, y: 0, width: size.width, height: Math.min(size.height, 900) } } : {}) });
    const gap = Math.round(16 * dpr), w = Math.round(size.width * dpr), h = Math.round(size.height * dpr);
    /* Composited first, resized after: sharp resizes before it composites, so a pipeline holding both would shrink the canvas under full-size shots. */
    const composite = await sharp({ create: { width: w * 2 + gap, height: h, channels: 3, background: "#808080" } })
      .composite([{ input: app, left: 0, top: 0 }, { input: protoShot, left: w + gap, top: 0 }]).png().toBuffer();
    const names = { app: `${tag}-app`, proto: `${tag}-proto`, beside: `${tag}-beside` };
    const files = [`${names.app}.png`, `${names.proto}.png`];
    await writeFile(path.join(dir, files[0]), app);
    await writeFile(path.join(dir, files[1]), protoShot);
    if (dpr === 1) {
      files.push(`${names.beside}.png`);
      await writeFile(path.join(dir, files[2]), composite);
    }
    /* Downscaled WebPs for the PR table: one screen is no wider than TABLE_WEBP_WIDTH, the side-by-side no wider than two of them; never enlarged. */
    const webp = (input: Buffer, maxWidth: number) => sharp(input).resize({ width: maxWidth, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    for (const [key, input, maxWidth] of [["app", app, TABLE_WEBP_WIDTH], ["proto", protoShot, TABLE_WEBP_WIDTH], ["beside", composite, TABLE_WEBP_WIDTH * 2]] as const) {
      files.push(`${names[key]}.webp`);
      await writeFile(path.join(dir, `${names[key]}.webp`), await webp(input, maxWidth));
    }
    await writeFile(path.join(dir, `${tag}.json`), JSON.stringify({ name, app: appPage.url().replace(/^https?:\/\/[^/]+/, ""), prototype: protoQuery, size, dpr }, null, 2));
    return { dir, files };
  } finally {
    await proto.close();
  }
}
