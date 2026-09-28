import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { buildRateTable } from "../lib/rateTable.server";
import { takeCost } from "../lib/breakdownCost";

/* Money on two screens, at every size: the printable statement leads back to
   where statements are listed, and drafted shots are priced in credits as
   they will bill, never the vendor's dollars printed as credits. */

const overflow = (page: Page) => page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));

test("a statement's back link opens Workspace › Plans & credits, and the page fits the screen", async ({ page }) => {
  await signInLocally(page.request);
  const month = new Date().toISOString().slice(0, 7);
  await page.goto(`/statements/${month}`);
  const back = page.getByRole("link", { name: "← Statements" });
  await expect(back).toHaveAttribute("href", "/suites?view=workspace&tab=credits");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (page.viewportSize()!.width < 900) {
    // A phone's targets: the way back, the project filter, the CSV and Print.
    for (const [name, control] of [
      ["back", back], ["project", page.getByRole("combobox", { name: "Project" }).locator("..")],
      ["csv", page.getByRole("link", { name: "Download CSV" })], ["print", page.getByRole("button", { name: "Print" })],
    ] as const) expect((await control.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
  }
  const width = await overflow(page);
  expect(width.scrollWidth).toBe(width.clientWidth);
  await back.click();
  /* A link from another page into the Suites keeps its view and tab: the
     shell used to read the page being left and open the Brief. A first visit
     to /suites compiles it on a dev server. */
  await expect(page.getByTestId("ws-plans")).toBeVisible({ timeout: 90_000 });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/suites");
  expect(url.searchParams.get("view")).toBe("workspace");
  expect(url.searchParams.get("tab")).toBe("credits");
});

test("drafted shots are priced in credits per take, as they bill", async ({ page }) => {
  await signInLocally(page.request);
  const made = await page.request.post("/api/projects", { data: { name: "Dawn ride" } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const projectId = ((await made.json()) as { id: string }).id;
  expect(projectId).toBeTruthy();
  const saved = await page.request.put("/api/atomik/treatment", {
    data: { projectId, title: "Dawn ride", logline: "A courier crosses a flooded city at dawn.", scenes: [{ n: 1, title: "Street", secs: 12, prose: "The street at dawn; a bicycle cuts through a flooded gutter." }] },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), projectId!);
  await page.goto("/atomik/breakdown");
  /* A scene's action only asks for its quote once it is on screen, which on a
     short landscape phone is below the fold. */
  await page.getByRole("button", { name: /^Draft shots/ }).scrollIntoViewIfNeeded();
  const draft = page.getByRole("button", { name: /^Draft shots · \d+ cr reserved$/ });
  await draft.click();
  const proposal = page.locator(".ak-proposal");
  await expect(proposal).toBeVisible({ timeout: 60_000 });

  const rates = buildRateTable("cr");
  /* One take, as the ledger bills it: whole credits, rounded up per take. */
  const take = (planned: number, engine: string) => Math.max(1, Math.ceil(takeCost(rates, planned, engine) - 1e-9));
  const seedance = take(5, "seedance"), kling = take(4, "kling");
  /* The rate card's Seedance 2.5, 5s 1080p line at US$0.80 a credit (SOW §7A). */
  expect(seedance).toBe(6);
  await expect(proposal.getByText(`5s · Seedance · ${seedance} cr`)).toBeVisible();
  await expect(proposal.getByText(`4s · Kling · ${kling} cr`)).toBeVisible();
  await expect(proposal).toContainText(`SCENE ≈ ${seedance + kling} cr AT ONE TAKE EACH · WRITING 1 cr`);
  await expect(proposal).not.toContainText("$");
  const width = await overflow(page);
  expect(width.scrollWidth).toBe(width.clientWidth);
});

test("a scene's action scrolled into view is quoted, even when a busy page hands over what it saw all at once", async ({ page }) => {
  await signInLocally(page.request);
  const made = await page.request.post("/api/projects", { data: { name: "Night market" } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const projectId = ((await made.json()) as { id: string }).id;
  /* Enough scenes that the last one's action starts well below the fold at every size. */
  const scenes = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, title: `Stall ${i + 1}`, secs: 5, prose: `A vendor at stall ${i + 1} fans the coals as the lamps come on.` }));
  const saved = await page.request.put("/api/atomik/treatment", { data: { projectId, title: "Night market", logline: "A market wakes as the city sleeps.", scenes } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  /* A quote is a read and goes through; anything that would run is refused and recorded. */
  const quoted: number[] = [];
  const ran: string[] = [];
  await page.route(/\/api\/(generate|atomik\/(ideas|shots)\/draft|atomik\/treatment\/scene)(\?.*)?$/, (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = (request.postDataJSON() ?? {}) as { quoteOnly?: boolean; scene?: number };
    if (body.quoteOnly === true && new URL(request.url()).pathname === "/api/atomik/shots/draft") { quoted.push(Number(body.scene)); return route.fallback(); }
    ran.push(new URL(request.url()).pathname);
    return route.abort();
  });
  /* A busy page (CI under load) delivers an observer's entries late and together, oldest first. A scene action's
     observer here is handed nothing until the action is in view, then everything at once; the action carries what
     is held (data-held) and each hand-over (data-looks). */
  await page.addInitScript(() => {
    const actions = new WeakSet<Element>();
    const Native = window.IntersectionObserver;
    window.IntersectionObserver = class extends Native {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        let held: IntersectionObserverEntry[] = [];
        super((entries, observer) => {
          const target = entries[0].target as HTMLElement;
          if (!actions.has(target) || !entries.every((e) => e.target === target)) return callback(entries, observer);
          held.push(...entries);
          if (!entries.some((e) => e.isIntersecting)) { target.dataset.held = String(held.length); return; }
          const all = held;
          held = [];
          delete target.dataset.held;
          target.dataset.looks = JSON.stringify([...JSON.parse(target.dataset.looks ?? "[]"), all.map((e) => e.isIntersecting)]);
          callback(all, observer);
        }, options);
      }
      observe(target: Element) {
        if (target.firstElementChild?.tagName === "BUTTON" && target.firstElementChild.textContent?.startsWith("Draft shots")) actions.add(target);
        super.observe(target);
      }
    };
  });
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), projectId);
  await page.goto("/atomik/breakdown");
  const drafts = page.getByRole("button", { name: /^Draft shots/ });
  await expect(drafts).toHaveCount(scenes.length, { timeout: 60_000 });
  const last = drafts.last();
  const action = last.locator("..");
  /* Below the fold, the last action's first look ("off screen") is held, so it is not quoted yet. */
  await expect(action).toHaveAttribute("data-held", "1");
  await expect(last).toHaveText("Draft shots");
  await last.scrollIntoViewIfNeeded();
  /* One hand-over, off screen then in view. The newest is where the action is: it asks for its quote. */
  await expect(action).toHaveAttribute("data-looks", "[[false,true]]");
  await expect(last).toHaveText(/^Draft shots · \d+ cr reserved$/, { timeout: 60_000 });
  expect(quoted).toContain(scenes.length);
  expect(ran).toEqual([]);
});

test("moving between Workspace tabs re-renders the shell, not the providers above it", async ({ page }) => {
  /* The Suites root reads its opening URL once. Reading useSearchParams on
     every render handed the providers fresh props on every URL the shell
     wrote, so each tab re-rendered the whole tree from the root. A stand-in
     DevTools hook sees each commit; a provider re-rendered from above gets a
     new props object, one that bailed out keeps the one it had. */
  await page.addInitScript(() => {
    const names = ["WorkspaceProvider", "ShellProvider", "RigProvider"];
    const last = new Map<string, unknown>();
    const changes: Record<string, number> = {};
    type Fiber = { type?: { name?: string } | string | null; memoizedProps?: unknown; child?: Fiber | null; sibling?: Fiber | null };
    const w = window as unknown as Record<string, unknown>;
    w.__providerPropChanges = changes;
    w.__providersSeen = () => [...last.keys()].sort();
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, isDisabled: false, renderers: new Map(),
      inject: () => 1, checkDCE: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        const stack: Fiber[] = [root.current];
        let found = 0;
        while (stack.length && found < names.length) {
          const f = stack.pop()!;
          const name = f.type && typeof f.type !== "string" ? f.type.name : undefined;
          if (name && names.includes(name)) {
            found++;
            if (last.has(name) && last.get(name) !== f.memoizedProps) changes[name] = (changes[name] ?? 0) + 1;
            last.set(name, f.memoizedProps);
          }
          if (f.sibling) stack.push(f.sibling);
          if (f.child) stack.push(f.child);
        }
      },
    };
  });
  await signInLocally(page.request);
  await page.goto("/suites?view=workspace&tab=credits");
  await expect(page.getByTestId("ws-plans")).toBeVisible({ timeout: 90_000 });
  const tabs = page.getByRole("tablist", { name: "Workspace sections" });
  const seen = () => page.evaluate(() => ({ ...((window as unknown as { __providerPropChanges: Record<string, number> }).__providerPropChanges) }));
  expect(await page.evaluate(() => (window as unknown as { __providersSeen: () => string[] }).__providersSeen())).toEqual(["RigProvider", "ShellProvider", "WorkspaceProvider"]);
  const before = await seen();
  await tabs.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByTestId("ws-usage")).toBeVisible();
  await tabs.getByRole("tab", { name: "People" }).click();
  await expect(page.getByTestId("ws-people")).toBeVisible();
  await tabs.getByRole("tab", { name: "Plans & credits" }).click();
  await expect(page.getByTestId("ws-plans")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("tab")).toBe("credits");
  expect(await seen()).toEqual(before);
});
