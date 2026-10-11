import { test, expect } from "@playwright/test";
import { publicTextCost } from "../../lib/textRunCost";
import { isOwnMedia } from "../../lib/format";
import { shellEntryRedirect, signInHrefFor } from "../../lib/signIn";
import { planOldRoute } from "../../lib/shell/old-routes";
import { PRIVATE_PATHS, PUBLIC_PATHS, publicPageMetadata, siteOrigin } from "../../lib/site";
import { NEUTRAL_ICON, reviewMetadata } from "../../lib/reviewMetadata";
import robots from "../../app/robots";
import nextConfig from "../../next.config";
import sitemap from "../../app/sitemap";

/* ── Atomik money: text runs are told in the workspace's unit ── */

test("only a file this app stores is downloaded in a batch; an engine's own URL is not", () => {
  expect(isOwnMedia("/api/media/gen_1")).toBe(true);
  expect(isOwnMedia("https://cdn.engine.example/out.mp4")).toBe(false);
  expect(isOwnMedia(null)).toBe(false);
});

test("a finished paid text run is told as the ledger billed it, never as vendor dollars, on credits", () => {
  expect(publicTextCost(true, 0.004, 1, "succeeded")).toEqual({ credits: 1 });
  expect(publicTextCost(true, 0.004, null, "succeeded")).toEqual({ credits: null });
  /* The reservation's figure is the estimate held, not what was billed. */
  expect(publicTextCost(true, 0.004, 2, "running")).toEqual({ credits: null });
  expect(publicTextCost(true, 0.004, 2, null)).toEqual({ credits: null });
  expect("costUsd" in publicTextCost(true, 0.004, 3, "succeeded")).toBe(false);
  expect(publicTextCost(false, 0.004, 1, "succeeded")).toEqual({ costUsd: 0.004 });
});

/* ── Sign-in and the switch-over ─────────────────────────────────────────── */

test("signing in comes back to the page and its query, not to a bare path", () => {
  expect(signInHrefFor("/generate", "mode=images&task=upscale&source=upload:x")).toBe(`/login?next=${encodeURIComponent("/generate?mode=images&task=upscale&source=upload:x")}`);
  expect(signInHrefFor("/library", "?all=1&view=references")).toBe(`/login?next=${encodeURIComponent("/library?all=1&view=references")}`);
  expect(signInHrefFor("/team")).toBe(`/login?next=${encodeURIComponent("/team")}`);
  expect(signInHrefFor("/")).toBe("/login");
  expect(signInHrefFor(null, "a=1")).toBe("/login");
});

test("a signed-out Suites link signs in and returns to its suite and page", () => {
  const query = "suite=atomik&page=runs&project=p1";
  expect(shellEntryRedirect("/suites", query)).toBe(`/login?next=${encodeURIComponent(`/suites?${query}`)}`);
  expect(shellEntryRedirect("/suites", "")).toBe(`/login?next=${encodeURIComponent("/suites")}`);
});

test("an old entry point always has a /suites address, and no way back to the old shell is left", () => {
  const target = planOldRoute("/workbench", "project=p1&stage=brief")!.to(null);
  expect(target).toBe("/suites?project=p1&view=board&region=brief");
  /* The old escape params are dropped: they choose nothing. */
  expect(planOldRoute("/workbench", "project=p1&shell=legacy")!.to(null)).toBe("/suites?project=p1&view=home");
  expect(planOldRoute("/workbench", "project=p1&new=1")!.to(null)).toBe("/suites?project=p1&view=home");
});

/* ── Public metadata ─────────────────────────────────────────────────────── */

test("the site origin comes from APP_ORIGIN, else the production deployment", () => {
  expect(siteOrigin({ APP_ORIGIN: "https://studio.example/path" })).toBe("https://studio.example");
  expect(siteOrigin({ APP_ORIGIN: "not a url", VERCEL_PROJECT_PRODUCTION_URL: "prod.example" })).toBe("https://prod.example");
  expect(siteOrigin({})).toBeNull();
});

test("robots keeps crawlers out of the API and one-time links; the sitemap lists public pages only", () => {
  const saved = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "https://studio.example";
  try {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    for (const path of ["/api/", "/invite/", "/reset/"]) expect(rules.disallow).toContain(path);
    /* A review link may be fetched for its preview card; its noindex keeps it out of every index. */
    expect(rules.disallow).not.toContain("/review/");
    expect(r.sitemap).toBe("https://studio.example/sitemap.xml");
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain("https://studio.example");
    expect(urls).toContain("https://studio.example/terms");
    expect(urls.length).toBe(PUBLIC_PATHS.length);
    for (const p of PRIVATE_PATHS) expect(urls.some((u) => u.includes(p))).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved;
  }
});

test("a client review page is answered with X-Robots-Tag noindex, and only it", async () => {
  const rules = await nextConfig.headers!();
  const review = rules.filter((r) => r.headers.some((h) => h.key === "X-Robots-Tag"));
  expect(review.map((r) => r.source)).toEqual(["/review/:path*"]);
  expect(review[0].headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" });
});

test("a public page carries its own title and a link-preview card", () => {
  const m = publicPageMetadata("Terms", "The terms.");
  expect(m.title).toBe("Terms · Particl");
  expect(m.openGraph.title).toBe("Terms · Particl");
  expect(m.openGraph.images[0].url).toBe("/icon.png?v=3");
  expect(m.twitter.card).toBe("summary");
});

test("a client review page carries the studio's name, a neutral icon and no Particl install manifest", () => {
  const m = reviewMetadata("Spring film · Studio A", "Approved takes for Spring film.", "Studio A");
  expect(m.manifest).toBeNull();
  expect(m.icons).toEqual({ icon: [{ url: NEUTRAL_ICON, type: "image/svg+xml" }], apple: [] });
  expect(m.appleWebApp).toEqual({ capable: false, title: "Spring film · Studio A" });
  expect(JSON.stringify(m)).not.toMatch(/particl/i);
  expect(m.robots).toEqual({ index: false, follow: false });
});
