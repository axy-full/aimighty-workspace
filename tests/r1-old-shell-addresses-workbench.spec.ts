import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { onPhone } from "./helpers/businessOwn";

const ADDRESSES = [
  "/suites?view=crew", "/suites?view=crew&cp=members", "/suites?view=crew&cp=sessions",
  "/suites?suite=business", "/suites?suite=business&page=hooks", "/suites?suite=moleculr&page=marketing&sp=ads",
  "/suites?suite=viral", "/suites?suite=viral&page=history", "/suites?suite=viral&page=swap", "/suites?suite=subatomik&sp=history",
  "/suites?suite=studio&page=stages", "/suites?suite=studio&page=home", "/suites?suite=particl&page=brief&sp=home", "/suites?suite=particl",
  "/suites?view=gen", "/suites?view=gen&mode=audio", "/suites?view=suite", "/suites?asset=generation%3Aabc",
  "/suites?make=motion", "/suites?sp=stages",
];

test("each old address 30x to its new place, and the landing is never an empty shell", async ({ page }, info) => {
  const phone = onPhone(info.project.name);
  await signInLocally(page.request);
  const rows: string[] = [];
  for (const path of ADDRESSES) {
    /* Follow by hand: the design file's spelling (suite=business) is one hop, then the screen registry's. At most two, the last final. */
    let at = path; const hops: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await page.request.get(at, { maxRedirects: 0 });
      if (res.status() === 200) break;
      expect([301, 302, 303, 307, 308], at).toContain(res.status());
      at = res.headers()["location"] ?? ""; hops.push(`${res.status()}`);
    }
    rows.push(`${hops.join(">")} ${path} -> ${at}`);
    expect(hops.length, path).toBeGreaterThan(0);
    expect(hops.length, path).toBeLessThanOrEqual(2);
    expect(at, path).not.toMatch(/view=crew|suite=(business|viral|moleculr|subatomik)(&|$)|sp=(stages|home)|page=(home|stages)/);
    expect(at, path).toMatch(/view=(home|board|workspace)|suite=atomik/);
    expect((await page.request.get(at, { maxRedirects: 0 })).status(), `${at} is final`).toBe(200);
  }
  console.log(rows.join("\n"));
  /* One browser landing per family: the shell mounts a screen, not an empty body. */
  for (const path of ["/suites?view=crew", "/suites?suite=viral&page=history", "/suites?suite=business&page=hooks", "/suites?suite=studio&page=stages", "/suites?view=gen", "/suites?asset=generation%3Aabc"]) {
    await page.goto(path);
    if (phone) {
      /* A phone mounts its own app, not the desktop shell: its root and a non-empty page inside it. */
      if (path.startsWith("/suites?asset=")) {
        /* A take link opens the link card (here: "not one of yours"), which the phone shows instead of the app. */
        await expect(page.getByTestId("link-card"), path).toContainText(/\S/, { timeout: 45_000 });
      } else {
        await expect(page.getByTestId("phone-app"), path).toBeVisible({ timeout: 45_000 });
        await expect(page.getByTestId("mobile-scroll").first(), path).toBeVisible({ timeout: 45_000 });
        await expect(page.getByTestId("mobile-scroll").first(), `${path}: not blank`).toContainText(/\S/);
      }
    } else {
      await expect(page.locator('[data-testid="screen"], [data-testid="shell-body"]').first(), path).toBeVisible({ timeout: 45_000 });
    }
    const url = new URL(page.url());
    expect(url.search, path).not.toMatch(/view=crew|sp=(stages|home)/);
  }
});
