import { test, expect } from "@playwright/test";
import { LARGER_TITLES, readPhone } from "../../components/graphite/phone/phone-model";

/** Activity, Memory and Skills have no phone screen until after the demo: their addresses say so (LargerScreen), whichever way they are written. */
test("the control room's Activity, Memory and Skills addresses are the 'larger screen' page on a phone, in both spellings", () => {
  for (const [search, page] of [
    ["?suite=atomik&page=runs", "activity"],
    ["?suite=atomik&page=agent&sp=runs", "activity"],
    ["?suite=atomik&page=memory", "memory"],
    ["?suite=atomik&page=agent&sp=memory", "memory"],
    ["?suite=atomik&page=saved-skills", "skills"],
    ["?suite=atomik&page=agent&sp=saved-skills", "skills"],
    ["?project=p1&suite=atomik&page=agent&sp=memory&device=phone", "memory"],
  ] as const) {
    expect(readPhone(search), search).toMatchObject({ larger: page, asked: "home" });
    expect(LARGER_TITLES[page]).toMatch(/^(Activity|Memory|Skills)$/);
  }
});

test("everything else keeps its screen: Approvals is Home, the phone's own screens and the other pages are not the larger-screen page", () => {
  for (const search of [
    "?suite=atomik&page=approvals", "?suite=atomik&page=agent", "?suite=atomik&page=budget", "?suite=atomik&page=skills", "?view=home", "",
    "?view=workspace&ws=team", "?screen=record&suite=atomik&page=memory", "?view=board&suite=atomik&page=memory", "?suite=particl&page=memory",
  ]) expect(readPhone(search).larger, search).toBeNull();
});

/** The board's 3D scene drawer (owner Q19) hosts the old render panel on the desktop; a phone has no screen for it and says so. */
test("the board's 3D scene drawer is the 'larger screen' page on a phone; the board's other drawers stay its Record", () => {
  for (const search of ["?view=board&drawer=render", "?project=p1&view=board&kind=studio&drawer=render&device=phone", "?suite=particl&page=astra&drawer=render"]) {
    expect(readPhone(search), search).toMatchObject({ larger: "render", asked: "home" });
  }
  expect(LARGER_TITLES.render).toBe("3D scene");
  for (const search of ["?view=board&drawer=history", "?view=board&drawer=library", "?view=board"]) {
    expect(readPhone(search), search).toMatchObject({ larger: null, asked: "record" });
  }
  expect(readPhone("?screen=record&view=board&drawer=render").larger).toBeNull();
});
