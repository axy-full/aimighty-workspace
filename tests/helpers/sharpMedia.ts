import { expect, type Page } from "@playwright/test";

/**
 * The sharpness check (owner, 16 Oct 2026, 15:05): "fails when an <img> is displayed larger than its natural size / 2".
 * On a 2x screen every CSS pixel a picture is drawn with needs two file pixels, so a picture drawn s CSS px per file px
 * is soft when s x 2 > 1 (1% allowance). It looks at every <img>, every <video> (the frame it plays and the poster it shows
 * until then) and, when asked, CSS background images.
 *
 *  - Real pixels, not `naturalWidth`: with srcset a picture's `naturalWidth` is its file's width divided by the candidate's
 *    density (a 256 px file picked as 2x reads 128). The file is decoded from `currentSrc` in a plain `new Image()` with no srcset.
 *  - Drawn size follows `object-fit` and `object-position`'s box (fill, cover, contain, scale-down, none) and the page's own
 *    transforms (the board's viewport zoom, a scaled card): it is the box's `getBoundingClientRect`, less padding and border drawn
 *    at the same scale, so what is measured is what the screen shows.
 *  - Vectors are skipped (`.svg`, `data:image/svg`): they are sharp at any size.
 *  - Exemptions are only an attribute in product code: `data-sharp-exempt="<reason>"` on the picture or any ancestor (the
 *    render card's deliberately blurred source). Never by URL or size here.
 *  - The page must be at a pixel ratio of 2 (`test.use({ deviceScaleFactor: 2 })`, or a context made with it): at 1 a srcset picks
 *    its 1x candidate and the check would pass for the wrong reason.
 *
 * `findSoftMedia` returns what is soft right now; `expectSharpMedia` polls until nothing is (pictures load, posters upgrade) and
 * fails listing each as `src, file px, drawn CSS px x 2`. Local ENGINE_MOCK server only; nothing is rendered or spent.
 */
export type SoftMedia = {
  kind: "img" | "video" | "poster" | "background";
  src: string;
  /** The file's real pixels. */
  file: { width: number; height: number };
  /** What the screen draws it at, in CSS px, after object-fit and the page's zoom. */
  drawn: { width: number; height: number };
  /** Drawn CSS px per file px, the larger of the two axes. At most 0.5 is sharp on a 2x screen. */
  scale: number;
  selector: string;
};

export type SharpMediaOptions = {
  /** Check `url()` backgrounds too (off by default: most are gradients, icons and patterns). */
  backgrounds?: boolean;
  /** Only media inside this selector (default: the whole page). */
  within?: string;
  /** How long to wait for pictures to load and posters to upgrade before failing (default 20 s). */
  timeout?: number;
  /** How long the answer must hold unchanged before it counts (default 2 s): a poster is captured, then upgraded to its tier. */
  settle?: number;
};

/** Sharp at 2x means at most this many CSS px per file px (1/2), plus a 1% allowance for rounding. */
export const MAX_CSS_PX_PER_FILE_PX = 0.5 * 1.01;

/** What one in-page pass found. `pending` is in-view media still loading (not judged yet); `broken` is media that loaded as nothing (not judged either). */
type Pass = { soft: SoftMedia[]; checked: number; pending: number; broken: number; dpr: number };

/** Runs in the page. Plain function, no imports: Playwright serialises it. */
function measureInPage({ backgrounds, within, max }: { backgrounds: boolean; within: string | null; max: number }): Promise<Pass> {
  const root: ParentNode = within ? document.querySelector(within) ?? document : document;
  const isVector = (src: string) => /^data:image\/svg/i.test(src) || /\.svg$/i.test(new URL(src, location.href).pathname);
  const decoded = new Map<string, Promise<{ width: number; height: number } | null>>();
  /* The file's own pixels: a plain Image, so no srcset divides them. */
  const probe = (src: string) => {
    let p = decoded.get(src);
    if (!p) {
      p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
        img.onerror = () => resolve(null);
        img.src = src;
      });
      decoded.set(src, p);
    }
    return p;
  };
  const describe = (el: Element) => {
    const id = el.getAttribute("data-testid");
    return `${el.tagName.toLowerCase()}${id ? `[data-testid="${id}"]` : el.id ? `#${el.id}` : (el.getAttribute("class") ?? "").trim() ? `.${(el.getAttribute("class") ?? "").trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
  };
  /* The box the picture is drawn in (content box, screen pixels): the rect less padding and border, drawn at the page's own scale (a zoomed canvas, a scaled card). */
  const contentBox = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const k = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
    const kv = el.offsetHeight > 0 ? r.height / el.offsetHeight : k;
    const f = (n: string) => parseFloat(cs.getPropertyValue(n)) || 0;
    return {
      width: Math.max(0, r.width - k * (f("padding-left") + f("padding-right") + f("border-left-width") + f("border-right-width"))),
      height: Math.max(0, r.height - kv * (f("padding-top") + f("padding-bottom") + f("border-top-width") + f("border-bottom-width"))),
      visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    };
  };
  /* Drawn CSS px per file px for an object-fit (a replaced element) in a box. */
  const fitScale = (fit: string, box: { width: number; height: number }, file: { width: number; height: number }) => {
    const sx = box.width / file.width, sy = box.height / file.height;
    switch (fit) {
      case "cover": { const s = Math.max(sx, sy); return { x: s, y: s }; }
      case "contain": { const s = Math.min(sx, sy); return { x: s, y: s }; }
      case "scale-down": { const s = Math.min(1, sx, sy); return { x: s, y: s }; }
      case "none": return { x: 1, y: 1 };
      default: return { x: sx, y: sy };
    }
  };
  const exempt = (el: Element) => el.closest("[data-sharp-exempt]") !== null;
  const soft: SoftMedia[] = [];
  let checked = 0, pending = 0, broken = 0;
  /* Only what is in the window can be waited for: a lazy picture further down never loads. */
  const inView = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };

  const judge = async (el: HTMLElement, kind: SoftMedia["kind"], src: string, fit: string) => {
    const box = contentBox(el);
    if (!box.visible || box.width < 1 || box.height < 1) return;
    if (isVector(src)) return;
    const file = await probe(src);
    if (!file) { broken++; return; }
    checked++;
    const s = fitScale(fit, box, file);
    const scale = Math.max(s.x, s.y);
    if (scale > max) {
      /* What is drawn: the file at that scale, clipped to the box (cover) or filling it (fill/contain). */
      soft.push({ kind, src, file, drawn: { width: Math.round(Math.min(file.width * s.x, fit === "cover" ? Infinity : box.width) * 10) / 10, height: Math.round(Math.min(file.height * s.y, fit === "cover" ? Infinity : box.height) * 10) / 10 }, scale: Math.round(scale * 1000) / 1000, selector: describe(el) });
    }
  };

  return (async () => {
    const jobs: Promise<void>[] = [];
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
      if (exempt(img)) continue;
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!src) continue;
      if (!img.complete) { if (inView(img)) pending++; continue; }
      jobs.push(judge(img, "img", src, getComputedStyle(img).objectFit));
    }
    for (const video of Array.from(root.querySelectorAll<HTMLVideoElement>("video"))) {
      if (exempt(video)) continue;
      const fit = getComputedStyle(video).objectFit;
      /* The frame it plays. A video that cannot decode here (no codec in this browser) has no size and is judged by its poster only. */
      if (video.videoWidth > 0 && video.readyState >= 2) {
        const box = contentBox(video);
        if (box.visible && box.width >= 1 && box.height >= 1) {
          checked++;
          const s = fitScale(fit, box, { width: video.videoWidth, height: video.videoHeight });
          const scale = Math.max(s.x, s.y);
          if (scale > max) soft.push({ kind: "video", src: video.currentSrc || video.src, file: { width: video.videoWidth, height: video.videoHeight }, drawn: { width: Math.round(video.videoWidth * s.x * 10) / 10, height: Math.round(video.videoHeight * s.y * 10) / 10 }, scale: Math.round(scale * 1000) / 1000, selector: describe(video) });
        }
      }
      /* The poster is what is drawn until the first frame is: a take shows its poster at rest. */
      const poster = video.getAttribute("poster");
      if (poster && video.readyState < 2) jobs.push(judge(video, "poster", new URL(poster, location.href).href, fit));
    }
    if (backgrounds) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        const cs = getComputedStyle(el);
        const m = /url\(["']?([^"')]+)["']?\)/.exec(cs.backgroundImage);
        if (!m || exempt(el)) continue;
        const sizing = cs.backgroundSize;
        const fit = sizing === "cover" || sizing === "contain" ? sizing : sizing === "100% 100%" ? "fill" : "";
        if (!fit) continue; /* an explicit or auto size: an icon or a pattern, not a picture filling its box */
        jobs.push(judge(el, "background", new URL(m[1], location.href).href, fit));
      }
    }
    await Promise.all(jobs);
    return { soft, checked, pending, broken, dpr: window.devicePixelRatio };
  })();
}

async function pass(page: Page, options: SharpMediaOptions): Promise<Pass> {
  return page.evaluate(measureInPage, { backgrounds: options.backgrounds ?? false, within: options.within ?? null, max: MAX_CSS_PX_PER_FILE_PX });
}

/** Every picture, video frame and poster drawn with more than half a file pixel per CSS pixel, right now (no waiting). Throws below a pixel ratio of 2. */
export async function findSoftMedia(page: Page, options: SharpMediaOptions = {}): Promise<SoftMedia[]> {
  const result = await pass(page, options);
  if (result.dpr < 2) throw new Error(`expectSharpMedia needs a pixel ratio of 2 (this page is ${result.dpr}): add test.use({ deviceScaleFactor: 2 }) or open a context with deviceScaleFactor: 2.`);
  return result.soft;
}

export const describeSoft = (m: SoftMedia) =>
  `${m.kind} ${m.selector} ${m.src.slice(0, 120)}: file ${m.file.width}x${m.file.height} px, drawn ${m.drawn.width}x${m.drawn.height} CSS px x 2 = ${Math.round(m.drawn.width * 2)}x${Math.round(m.drawn.height * 2)} px (${m.scale.toFixed(2)} CSS px per file px, at most 0.50)`;

/**
 * Fails when any picture, video frame or poster on the page is drawn with more than half a file pixel per CSS pixel. Waits (up to
 * `timeout`, the answer holding for `settle`) for pictures to load and posters to upgrade, so it is safe right after navigation. Also fails when the page holds no
 * media at all, since a check that looked at nothing proved nothing.
 */
export async function expectSharpMedia(page: Page, options: SharpMediaOptions = {}): Promise<{ checked: number }> {
  let last: Pass | null = null;
  let held = "", since = 0;
  const settle = options.settle ?? 2_000;
  await expect.poll(async () => {
    last = await pass(page, options);
    if (last.dpr < 2) throw new Error(`expectSharpMedia needs a pixel ratio of 2 (this page is ${last.dpr}): add test.use({ deviceScaleFactor: 2 }) or open a context with deviceScaleFactor: 2.`);
    const problems = last.soft.map(describeSoft);
    if (last.pending) problems.push(`${last.pending} picture(s) in view are still loading`);
    if (problems.length) { held = ""; return problems; }
    /* Nothing soft right now: believe it once it has held for `settle`, so a poster about to be upgraded is waited for. */
    const key = String(last.checked);
    if (key !== held) { held = key; since = Date.now(); }
    return Date.now() - since >= settle ? [] : [`settling (${last.checked} checked)`];
  }, { timeout: options.timeout ?? 20_000, intervals: [250, 500, 1000], message: "pictures, video frames and posters are drawn with at least 2 file pixels per CSS pixel" }).toEqual([]);
  const done = last as Pass | null;
  expect(done?.checked ?? 0, "there is media on the page to check (a check that looked at nothing proves nothing)").toBeGreaterThan(0);
  return { checked: done?.checked ?? 0 };
}
