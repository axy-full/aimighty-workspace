import { test, expect } from "@playwright/test";
import { OLD_TO_NEW, PENDING, normalize } from "../../lib/shell/ia";
import { fromMakeLink } from "../../lib/shell/make";
import { SCREENS, atomikAt, isLanded, phoneAt, route, sameSearch, screenAt, screenParams, spelling, type ScreenId, type ScreenModule } from "../../lib/shell/screens";
import { applyRows, matchRow } from "../../lib/shell/screen-rows";
import { SHELL_PARAMS, shellParams } from "../../lib/shell/state";

/**
 * The screen registry and the routing pipeline (lib/shell/screens.ts): every README § 1.2 row, in the design file's form and the
 * app's, with nothing landed, with each screen landed alone, and with all of them. Pure: it uses the registry's real modules,
 * with `landed` set per case. There is no switch: a landed screen shows for everyone.
 */
const IDS = SCREENS.map((s) => s.id);
const NEEDS_BOARD: ScreenId[] = ["board-ads", "board-social"];
/** The screens a case has landed. Make is landed from the start (it has been live since D0). */
const landed = (...ids: ScreenId[]): ScreenModule[] => SCREENS.map((s) => ({ ...s, landed: s.id === "make" || ids.includes(s.id) }));
const NONE = landed();
const ALL = landed(...IDS);
const SETS: [string, ScreenModule[]][] = [["nothing landed", NONE], ...IDS.filter((id) => id !== "make").map((id): [string, ScreenModule[]] => [`${id} landed alone`, landed(id)]), ["board and Ads landed", landed("board", "board-ads")], ["everything landed", ALL]];

const appForms = PENDING.filter((p) => p.from.startsWith("?")).map((p) => p.from);
const designForms = OLD_TO_NEW.map((r) => r.from).filter(Boolean);
const rowTargets = (screens: readonly ScreenModule[]) => screens.flatMap((s) => [...s.rows, ...s.fallback]).flatMap((r) => [r.from, r.to]);
const EVERY_ADDRESS = [...new Set([...appForms, ...designForms, ...rowTargets(ALL), "", "?project=ws-1", "?atomik=1", "?settings=1", "?find=1&q=go%20to%20cast", "?make=image", "?view=home&atomik=how&q=hi"])];

const params = (search: string) => Object.fromEntries(new URLSearchParams(search));

test("module ids are unique, every module is in the registry, and each declares the pure shape", () => {
  expect(new Set(IDS).size).toBe(IDS.length);
  expect([...IDS].sort()).toEqual(["atomik", "board", "board-ads", "board-social", "control-room", "home", "make", "phone", "settings"]);
  for (const s of SCREENS) {
    expect(typeof s.landed, s.id).toBe("boolean");
    for (const key of s.params) expect(typeof key, s.id).toBe("string");
    for (const row of [...s.rows, ...s.fallback]) { expect(row.from.startsWith("?"), `${s.id} ${row.from}`).toBe(true); expect(row.to.startsWith("?"), `${s.id} ${row.to}`).toBe(true); }
  }
  expect(SCREENS.filter((s) => s.landed).length).toBeGreaterThan(0);
});

test("every landed module's rows move its old addresses, and an unlanded module's fallback applies", () => {
  for (const screen of SCREENS) {
    const own = (landedFlag: boolean) => SCREENS.map((s) => (s.id === screen.id ? { ...s, landed: landedFlag } : s));
    const mounted = own(true), unmounted = own(false);
    if (isLanded(screen.id, SCREENS)) {
      for (const row of screen.rows) {
        /* The address may also gain Home's own `view=home` (a panel over Home), so it carries every param the row sets, not only them. */
        const out = params(route(row.from));
        for (const [key, value] of Object.entries(params(row.to))) expect(out[key], `${screen.id}: ${row.from} → ${row.to}`).toBe(value);
      }
      for (const row of screen.fallback) expect(sameSearch(route(row.from), row.to), `${screen.id} fallback ${row.from}`).toBe(false);
    }
    /* Not landed: its new addresses open today's page. */
    for (const row of screen.fallback) expect(sameSearch(route(row.from, unmounted), row.to), `${screen.id} unlanded: ${row.from}`).toBe(true);
    for (const row of screen.rows) expect(sameSearch(route(row.from, unmounted), row.to), `${screen.id} unlanded row ${row.from}`).toBe(false);
    expect(isLanded(screen.id, mounted) || (NEEDS_BOARD.includes(screen.id) && !isLanded("board", mounted))).toBe(true);
    expect(isLanded(screen.id, unmounted)).toBe(false);
  }
});

test("the design file's spellings land on the app's forms, whatever has landed", () => {
  for (const row of OLD_TO_NEW) {
    if (!row.to) continue;
    /* With nothing landed the app's form is exactly the design's, spelled the app's way; with screens landed it may move on, never back to the design's. */
    expect(sameSearch(route(row.from, NONE), fromMakeLink(row.to) ?? row.to), `${row.from} (nothing landed)`).toBe(true);
    for (const [, screens] of SETS) expect(new URLSearchParams(route(row.from, screens)).get("palette"), row.from).toBeNull();
  }
  expect(route("?palette=1&q=hi", ALL)).toContain("find=1");
  expect(params(route("?palette=1&q=hi", ALL)).q).toBe("hi");
});

test("the old Gen page and Viral's two tools become Make's addresses, as D0 reads them", () => {
  for (const [from, to] of [["?view=gen&mode=video", "?make=video"], ["?view=gen&mode=images", "?make=image"], ["?suite=subatomik&page=motion", "?make=motion"], ["?suite=viral&page=swap", "?make=swap"]]) {
    expect(sameSearch(route(from, NONE), to), from).toBe(true);
  }
});

test("Settings' sections: `ws=<section>` is `tab=<section>`, then a screen or today's page", () => {
  for (const id of ["team", "credits", "rules", "connections", "advanced"]) expect(params(spelling(`?view=workspace&ws=${id}`)), id).toMatchObject({ view: "workspace", tab: id });
  /* A workspace id that is not a section is never read as one. */
  expect(spelling("?view=workspace&ws=w_42")).toBe("?view=workspace&ws=w_42");
  /* Nothing landed: a section opens the page that holds it today. */
  expect(sameSearch(route("?view=workspace&ws=team", NONE), "?view=workspace&tab=people")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=team&open=security", NONE), "?view=workspace&tab=security")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=rules", NONE), "?suite=atomik&page=budget")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=connections", NONE), "?suite=atomik&page=skills")).toBe(true);
  /* Landed: the old tabs open their sections, and Settings' own addresses stay. */
  expect(sameSearch(route("?view=workspace&tab=people", ALL), "?view=workspace&tab=team")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=team", ALL), "?view=workspace&tab=team")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=usage", ALL), "?view=workspace&tab=credits&open=usage")).toBe(true);
});

test("the board's rows: each old Studio page is a region, once the board has landed", () => {
  const board = landed("board");
  const to = (from: string) => route(from, board);
  expect(sameSearch(to("?suite=particl&page=rig"), "?view=board")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=rig&rig=list"), "?view=board&list=1")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=brief"), "?view=board&region=brief")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=brief&sp=beats"), "?view=board&region=storyboard")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=brief&sp=beats&beats=graph"), "?view=board")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=boards"), "?view=board&region=storyboard")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=boards&sp=environment"), "?view=board&region=cast")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=cast"), "?view=board&region=cast")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=takes"), "?view=board&region=shots")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=astra"), "?view=board&region=shots")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=edit"), "?view=board&region=cut")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=deliver"), "?view=board&region=deliver")).toBe(true);
  expect(sameSearch(to("?view=crew&cp=room"), "?view=board&frame=m")).toBe(true);
  expect(sameSearch(to("?view=crew&cp=sessions"), "?view=board&frame=n")).toBe(true);
  /* The shell writes `sp` for every page it shows: an old `&sp=brief` leaves with the page, it does not ride into the board. */
  expect(sameSearch(to("?suite=particl&page=brief&sp=brief&project=ws-1"), "?view=board&region=brief&project=ws-1")).toBe(true);
  expect(sameSearch(to("?suite=particl&page=rig&sp=rig&sel=shot:s1"), "?view=board&sel=shot:s1")).toBe(true);
  /* The stage pages are deleted, so the board has no way back: a board address is never sent to one, landed or not. */
  expect(sameSearch(route("?view=board&region=cut", NONE), "?view=board&region=cut")).toBe(true);
  expect(sameSearch(route("?view=board&region=cut", NONE), "?view=board&region=cut")).toBe(true);
  /* Once landed it is one board for everyone. */
  expect(sameSearch(route("?view=board", ALL), "?view=board")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=edit", ALL), "?view=board&region=cut")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=edit", landed("board")), "?view=board&region=cut")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=edit", NONE), "?suite=particl&page=edit")).toBe(true);
  expect(sameSearch(route("?view=board&list=1&kind=studio", NONE), "?view=board&list=1&kind=studio")).toBe(true);
});

test("Ads and Social boards need the board too; the Business pages and Viral's History are deleted as pages, so nothing falls back to them", () => {
  const adsOnly = landed("board-ads");
  expect(isLanded("board-ads", adsOnly)).toBe(false);
  /* Without the board, the old addresses are left as they are (the pages behind them are not shown to anyone once the board has landed). */
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=hooks", adsOnly), "?suite=moleculr&page=marketing&sp=hooks")).toBe(true);
  expect(sameSearch(route("?view=board&kind=ads&frame=2", adsOnly), "?view=board&kind=ads&frame=2")).toBe(true);
  const both = landed("board", "board-ads", "board-social");
  expect(isLanded("board-ads", both)).toBe(true);
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=dtc", both), "?view=board&kind=ads&frame=2&card=image-ad")).toBe(true);
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=design&sp=design", both), "?view=board&kind=ads&frame=3")).toBe(true);
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=brand", both), "?view=board&kind=ads&frame=1&card=brand")).toBe(true);
  /* The suite, and its backing page with no `sp`, are the Ads board too; Viral's History is the Social board's History drawer. */
  expect(sameSearch(route("?suite=moleculr&page=marketing&project=ws-1", both), "?view=board&kind=ads&project=ws-1")).toBe(true);
  expect(sameSearch(route("?suite=moleculr", both), "?view=board&kind=ads")).toBe(true);
  expect(sameSearch(route("?suite=subatomik&page=history&sp=history", both), "?view=board&kind=social&drawer=history")).toBe(true);
  /* An address that already names a board is not an old page, whatever suite the state layer wrote beside it. */
  expect(sameSearch(route("?view=board&kind=ads&suite=moleculr&page=marketing", both), "?view=board&kind=ads&suite=moleculr&page=marketing")).toBe(true);
});

test("Home: the Studio overview opens it once landed; a bare landing does too; before that, the overview", () => {
  const home = landed("home");
  expect(sameSearch(route("?suite=particl&page=brief&sp=stages", home), "?view=home")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=brief&sp=stages&project=ws-1", home), "?view=home&project=ws-1")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=brief&sp=home", home), "?view=home")).toBe(true);
  expect(sameSearch(route("", home), "?view=home")).toBe(true);
  expect(sameSearch(route("?project=ws-1", home), "?view=home&project=ws-1")).toBe(true);
  /* A page that is named is not a bare landing. */
  expect(route("?suite=particl&page=brief", home)).toBe("?suite=particl&page=brief");
  expect(route("?make=image", home)).toBe("?make=image");
  expect(route("?view=workspace&tab=credits", home)).toBe("?view=workspace&tab=credits");
  /* Not landed: today's Studio overview, and a bare landing stays bare. */
  expect(sameSearch(route("?view=home", NONE), "?suite=particl&page=brief&sp=stages")).toBe(true);
  expect(route("", NONE)).toBe("");
});

test("Atomik: the Agent page is the panel over Home once landed; `atomik=` is the old Agent page before that", () => {
  const both = landed("atomik", "home");
  expect(sameSearch(route("?suite=atomik&page=agent", both), "?view=home&atomik=1")).toBe(true);
  expect(sameSearch(route("?suite=atomik&page=agent", landed("atomik")), "?atomik=1")).toBe(true);
  expect(sameSearch(route("?atomik=how&q=hi", NONE), "?suite=atomik&page=agent&q=hi")).toBe(true);
  expect(sameSearch(route("?atomik=1", ALL), "?suite=atomik&page=agent")).toBe(true);
  expect(atomikAt("?atomik=1", both)).toBe("panel");
  expect(atomikAt("?atomik=how", both)).toBe("how");
  expect(atomikAt("?atomik=1", NONE)).toBeNull();
  expect(atomikAt("?atomik=nope", both)).toBeNull();
});

test("the control room keeps its four addresses; Workspace's Dashboard is Activity", () => {
  const cr = landed("control-room");
  for (const url of ["?suite=atomik&page=approvals", "?suite=atomik&page=runs", "?suite=atomik&page=agent&sp=memory", "?suite=atomik&page=agent&sp=saved-skills"]) {
    expect(sameSearch(route(url, cr), url), url).toBe(true);
    expect(screenAt(url, cr), url).toBe("control-room");
    expect(screenAt(url, NONE), url).toBeNull();
  }
  expect(sameSearch(route("?view=workspace&tab=dashboard", cr), "?suite=atomik&page=runs")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=dashboard", NONE), "?view=workspace&tab=dashboard")).toBe(true);
  expect(screenAt("?suite=atomik&page=budget", cr)).toBeNull();
});

test("the phone: compact widths, or `device=phone` at any width; landed only", () => {
  const phone = landed("phone");
  expect(phoneAt("", true, phone)).toEqual({ on: true, framed: false });
  expect(phoneAt("", false, phone)).toEqual({ on: false, framed: false });
  expect(phoneAt("?device=phone", false, phone)).toEqual({ on: true, framed: true });
  expect(phoneAt("?device=phone", true, phone)).toEqual({ on: true, framed: false });
  expect(phoneAt("?device=phone", true, NONE)).toEqual({ on: false, framed: false });
  expect(phoneAt({ device: "phone" }, false, phone).framed).toBe(true);
});

test("which screen an address mounts: only once landed", () => {
  expect(screenAt("?view=home", landed("home"))).toBe("home");
  expect(screenAt("?view=home", ALL)).toBe("home");
  expect(screenAt("?view=home", NONE)).toBeNull();
  expect(screenAt("?view=board&kind=ads", ALL)).toBe("board-ads");
  expect(screenAt("?view=board&kind=social", ALL)).toBe("board-social");
  expect(screenAt("?view=board&kind=ads", landed("board"))).toBe("board");
  expect(screenAt("?view=board", landed("board"))).toBe("board");
  expect(screenAt("?view=board", landed("board-ads"))).toBeNull();
  expect(screenAt("?view=workspace&tab=team", landed("settings"))).toBe("settings");
  expect(screenAt("?view=workspace&tab=team", NONE)).toBeNull();
  expect(screenAt("?view=crew&cp=room", ALL)).toBeNull();
});

test("a result is final, in every case: routing a routed address changes nothing (no chains)", () => {
  for (const [name, screens] of SETS) {
    for (const url of EVERY_ADDRESS) {
      const once = route(url, screens);
      const twice = route(once, screens);
      expect(sameSearch(twice, once), `${url} → ${once} → ${twice} (${name})`).toBe(true);
    }
  }
});

test("every param rides along, whichever way an address moves", () => {
  const carried = "project=ws-1&asset=generation%3Agen_1&sel=shot%3As1&find=1&production=prod_7&import=board_3&higgsfield=1";
  for (const [name, screens] of SETS) {
    {
      for (const url of [...appForms, ...designForms]) {
        const own = new URLSearchParams(url);
        /* Viral's two tools become Make's, which drops the shell's own `sel` (lib/shell/make.ts › fromViralLink, as D0 has it). */
        const extra = Object.fromEntries([...new URLSearchParams(carried)].filter(([k]) => !own.has(k) && !(k === "sel" && (own.get("page") === "rig" || fromMakeLink(normalize(url))))));
        const out = params(route(`${url || "?"}${url ? "&" : ""}${new URLSearchParams(extra)}`, screens));
        for (const [key, value] of Object.entries(extra)) expect(out[key], `${url} keeps ${key} (${name})`).toBe(value);
      }
    }
  }
});

test("no row sends an address to a screen that has not landed", () => {
  for (const [name, screens] of SETS) {
    for (const screen of screens.filter((s) => isLanded(s.id, screens))) {
      for (const row of screen.rows) {
        const to = new URLSearchParams(row.to);
        if (to.has("view") || to.has("atomik") || to.get("suite") === "atomik") {
          const mounted = screenAt(row.to, screens) ?? (atomikAt(row.to, screens) ? "atomik" : null);
          /* A row to a page of today's (Settings' interim pages) names no new screen; every other target must be one that landed. */
          const today = to.get("view") === "workspace" || to.get("view") === "crew" || to.has("suite");
          if (!today) expect(mounted, `${screen.id}: ${row.from} → ${row.to} (${name})`).not.toBeNull();
        }
      }
    }
  }
});

test("each README § 1.2 link that has a screen of its own is in exactly one module's rows, once everything has landed", () => {
  const owners = (url: string) => SCREENS.filter((s) => s.rows.some((r) => sameSearch(r.from, url))).map((s) => s.id);
  for (const p of PENDING.filter((x) => x.from.startsWith("?"))) {
    /* The old Gen page and Viral's tools are Make's (fromMakeLink), not a module's rows. */
    if (fromMakeLink(p.from)) continue;
    /* A bare address (`?find=1`) names no page: it opens Home once Home has landed, which is no module's row. */
    if (!["view", "suite", "page", "sp", "make", "cp", "tab"].some((key) => new URLSearchParams(p.from).has(key))) continue;
    const moved = !sameSearch(route(p.from, ALL), p.from);
    const own = owners(p.from);
    if (moved) expect(own.length, `${p.from} has one owner (${own.join(", ")})`).toBe(1);
    /* A link no module moves is served where it is: Make's own (fromMakeLink), a same-URL control-room page, or a page whose screen has not drawn it. */
    else expect(own, p.from).toEqual([]);
  }
  /* The rows the plan promises, by owner. */
  const expected: Record<string, ScreenId> = {
    "?suite=particl&page=brief&sp=stages": "home", "?suite=particl&page=rig": "board", "?suite=particl&page=takes": "board", "?suite=particl&page=deliver": "board",
    "?view=crew&cp=sessions": "board", "?suite=moleculr&page=marketing&sp=dtc": "board-ads", "?suite=moleculr&page=marketing&sp=design": "board-ads",
    "?suite=atomik&page=agent": "atomik", "?view=workspace&tab=dashboard": "control-room",
  };
  for (const [url, id] of Object.entries(expected)) expect(owners(url), url).toEqual([id]);
});

test("each module's params are kept across the shell's writes", () => {
  const kept = shellParams();
  for (const key of SHELL_PARAMS) expect(kept).toContain(key);
  for (const key of ["kind", "frame", "list", "region", "drawer", "review", "card", "atomik", "q", "screen", "device", "from", "run", "take", "open", "start"]) expect(kept, key).toContain(key);
  /* `settings` and `palette` are one-shot: read on landing, never kept. */
  expect(kept).not.toContain("settings");
  expect(kept).not.toContain("palette");
  expect(new Set(kept).size).toBe(kept.length);
  expect(screenParams(SCREENS).sort()).toEqual([...new Set(SCREENS.flatMap((s) => [...s.params]))].sort());
});
