import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

/* Money, at every size: the printable statement leads back to where statements
   are listed. (The drafted-shots pricing checks drove the old Atomik breakdown
   page, which is gone; shot prices in credits are held by r1-port-credit-units.) */

const overflow = (page: Page) => page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));

test("a statement's back link opens Workspace › Plans & credits, and the page fits the screen", async ({ page }) => {
  await signInLocally(page.request);
  // Compile the destination before opening the browser document, so dev HMR
  // cannot replace that document while its real navigation is being asserted.
  const destination = await page.request.get("/suites?view=workspace&tab=credits");
  expect(destination.ok()).toBe(true);
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
  await expect(page.getByTestId("settings-plan")).toBeVisible({ timeout: 90_000 });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/suites");
  expect(url.searchParams.get("view")).toBe("workspace");
  expect(url.searchParams.get("tab")).toBe("credits");
});

test("moving between Settings sections re-renders the shell, not the providers above it", async ({ page }) => {
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
  await expect(page.getByTestId("settings-plan")).toBeVisible({ timeout: 90_000 });
  const seen = () => page.evaluate(() => ({ ...((window as unknown as { __providerPropChanges: Record<string, number> }).__providerPropChanges) }));
  expect(await page.evaluate(() => (window as unknown as { __providersSeen: () => string[] }).__providersSeen())).toEqual(["RigProvider", "ShellProvider", "WorkspaceProvider"]);
  const before = await seen();
  await page.getByTestId("settings-fold-usage-toggle").click();
  await expect(page.getByTestId("settings-fold-usage")).toHaveAttribute("data-open", "true");
  await page.getByTestId("settings-section-team").click();
  await expect(page.getByTestId("settings-people")).toBeVisible();
  await page.getByTestId("settings-section-credits").click();
  await expect(page.getByTestId("settings-plan")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("tab")).toBe("credits");
  expect(await seen()).toEqual(before);
});
