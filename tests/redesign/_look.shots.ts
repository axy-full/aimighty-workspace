import { test } from "@playwright/test";
import { openPrototype, closePrototypeServer } from "../helpers/redesignShots";
test.afterAll(closePrototypeServer);
for (const [name, q] of [["g-home", "?guest=1"], ["g-make", "?guest=1&view=make"], ["g-board", "?guest=1&view=board"], ["g-other", "?guest=1&view=board&project=other"], ["g-inv", "?guest=1&invite=team"], ["g-new", "?guest=1&invite=new"], ["g-plan", "?guest=1&invite=new&step=plan"], ["g-exp", "?guest=1&invite=expired"], ["g-start", "?guest=1&join=start"]] as const) {
  test(name, async ({ page }) => {
    await openPrototype(page, q);
    await page.screenshot({ path: `/tmp/particl-suites/rd-p2a/look-${name}.png` });
  });
}
