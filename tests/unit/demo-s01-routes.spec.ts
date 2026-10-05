import { test, expect } from "@playwright/test";
import { OLD_TO_NEW, PENDING, normalize } from "../../lib/shell/ia";
import { fromMakeLink } from "../../lib/shell/make";
import { SCREENS, atomikAt, isLanded, isVisible, phoneAt, route, sameSearch, screenAt, screenParams, spelling, type ScreenId, type ScreenModule } from "../../lib/shell/screens";
import { applyRows, matchRow } from "../../lib/shell/screen-rows";
import { SHELL_PARAMS, shellParams } from "../../lib/shell/state";

/**
 * The screen registry and the routing pipeline (lib/shell/screens.ts): every README § 1.2 row, in the design file's form and the
 * app's, with the switch off, on with nothing landed, on with each screen landed alone, and on with all of them. Pure: it uses
 * the registry's real modules, with `landed` set per case.
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
  /* Whichever modules have landed (each stream flips its own flag in its own PR) is read from the registry, never listed here. */
  expect(SCREENS.filter((s) => s.landed).length).toBeGreaterThan(0);
});

test("every landed module mounts and every other one falls back, whichever the registry says has landed", () => {
  for (const screen of SCREENS) {
    const own = (landedFlag: boolean) => SCREENS.map((s) => (s.id === screen.id ? { ...s, landed: landedFlag } : s));
    const mounted = own(true), unmounted = own(false);
    /* Landed (and, for a kind of board, with the board itself landed): its old addresses move to it, with the switch on only. */
    if (isLanded(screen.id, SCREENS)) {
      for (const row of screen.rows) {
        /* The address may also gain Home's own `view=home` (a panel over Home), so it carries every param the row sets, not only them. */
        const out = params(route(row.from, true));
        for (const [key, value] of Object.entries(params(row.to))) expect(out[key], `${screen.id}: ${row.from} → ${row.to}`).toBe(value);
        /* With the switch off a module's rows apply only if it shows for everyone (the board, by the owner's decision). */
        expect(sameSearch(route(row.from, false), row.to), `${screen.id} off: ${row.from}`).toBe(Boolean(screen.always));
      }
      for (const row of screen.fallback) expect(sameSearch(route(row.from, true), row.to), `${screen.id} fallback ${row.from}`).toBe(false);
    }
    /* Not landed: its new addresses open today's page, with the switch on or off. */
    for (const row of screen.fallback) {
      for (const on of [false, true]) expect(sameSearch(route(row.from, on, unmounted), row.to), `${screen.id} unlanded: ${row.from} (${on ? "on" : "off"})`).toBe(true);
    }
    for (const row of screen.rows) expect(sameSearch(route(row.from, true, unmounted), row.to), `${screen.id} unlanded row ${row.from}`).toBe(false);
    /* The registry's own answer to "does it mount" follows the flag. */
    expect(isLanded(screen.id, mounted) || (NEEDS_BOARD.includes(screen.id) && !isLanded("board", mounted))).toBe(true);
    expect(isLanded(screen.id, unmounted)).toBe(false);
  }
});

test("with the switch off every address the shell serves today is left as it is, except the pages the board replaces for everyone", () => {
  /* The board is one board for everyone (owner decision, 5 Oct): its modules' rows apply with the switch off, so an old Studio stage, a Crew page or a Business
     Ads page opens its region. Nothing else moves. */
  const boardRows = SCREENS.filter((s) => s.always && isLanded(s.id)).flatMap((s) => s.rows.map((r) => r.from));
  const replaced = (url: string) => boardRows.some((from) => sameSearch(new URLSearchParams(from).toString(), [...new URLSearchParams(from).keys()].reduce((acc, k) => { const v = new URLSearchParams(url).get(k); return v === null ? acc : `${acc}${acc ? "&" : ""}${k}=${v}`; }, "")));
  for (const url of [...appForms, "", "?project=ws-1", "?find=1", "?view=workspace&tab=credits", "?view=crew&cp=room", "?suite=moleculr&page=marketing&sp=hooks", "?page=takes&sp=takes&asset=generation:gen_1"]) {
    /* Only today's own rewrites (the design file's spellings, the old Gen and Viral tool links) apply, and they apply in both modes. */
    const out = route(url, false);
    if (sameSearch(out, spelling(url))) continue;
    expect(new URLSearchParams(out).get("view"), `${url} → ${out}`).toBe("board");
    expect(replaced(spelling(url)), `${url} is one the board's rows replace`).toBe(true);
  }
  /* Home, Atomik, Settings, the control room and the phone stay behind the switch. */
  for (const url of ["?suite=particl&page=brief&sp=stages", "?suite=atomik&page=agent", "?suite=atomik&page=approvals", "?view=workspace&tab=people", "?view=home"]) {
    expect(sameSearch(route(url, false), spelling(url)) || url === "?view=home", url).toBe(true);
  }
  expect(route("", false)).toBe("");
});

test("the design file's spellings land on the app's forms, in both modes, whatever has landed", () => {
  for (const row of OLD_TO_NEW) {
    for (const [name, screens] of SETS) {
      if (!row.to) continue;
      for (const on of [false, true]) {
        const out = route(row.from, on, screens);
        /* With the switch on and a screen landed, the app's form may move on to the new screen: never back to the design's. */
        if ((!on && !screens.some((s) => isVisible(s.id, false, screens))) || screens === NONE) expect(sameSearch(out, fromMakeLink(row.to) ?? row.to), `${row.from} (${name}, ${on ? "on" : "off"})`).toBe(true);
        expect(new URLSearchParams(out).get("palette"), row.from).toBeNull();
      }
    }
  }
  expect(route("?palette=1&q=hi", true, ALL)).toContain("find=1");
  expect(params(route("?palette=1&q=hi", true, ALL)).q).toBe("hi");
});

test("the old Gen page and Viral's two tools become Make's addresses in both modes, as D0 reads them", () => {
  for (const [from, to] of [["?view=gen&mode=video", "?make=video"], ["?view=gen&mode=images", "?make=image"], ["?suite=subatomik&page=motion", "?make=motion"], ["?suite=viral&page=swap", "?make=swap"]]) {
    for (const on of [false, true]) expect(sameSearch(route(from, on, NONE), to), `${from} ${on}`).toBe(true);
  }
});

test("Settings' sections: `ws=<section>` is `tab=<section>` in both modes, then a screen or today's page", () => {
  for (const id of ["team", "credits", "rules", "connections", "advanced"]) expect(params(spelling(`?view=workspace&ws=${id}`)), id).toMatchObject({ view: "workspace", tab: id });
  /* A workspace id that is not a section is never read as one. */
  expect(spelling("?view=workspace&ws=w_42")).toBe("?view=workspace&ws=w_42");
  /* Nothing landed, or the switch off: a section opens the page that holds it today. */
  expect(sameSearch(route("?view=workspace&ws=team", false, NONE), "?view=workspace&tab=people")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=team&open=security", true, NONE), "?view=workspace&tab=security")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=rules", true, NONE), "?suite=atomik&page=budget")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=connections", false, ALL), "?suite=atomik&page=skills")).toBe(true);
  /* Landed, with the switch on: the old tabs open their sections, and Settings' own addresses stay. */
  expect(sameSearch(route("?view=workspace&tab=people", true, ALL), "?view=workspace&tab=team")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=team", true, ALL), "?view=workspace&tab=team")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=usage", true, ALL), "?view=workspace&tab=credits&open=usage")).toBe(true);
});

test("the board's rows: each old Studio page is a region, with the switch on and the board landed", () => {
  const board = landed("board");
  const to = (from: string) => route(from, true, board);
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
  /* With the board not landed the board's addresses open today's page; once landed it is one board for everyone, switch on or off. */
  expect(sameSearch(route("?view=board&region=cut", true, NONE), "?suite=particl&page=edit")).toBe(true);
  expect(sameSearch(route("?view=board&region=cut", false, NONE), "?suite=particl&page=edit")).toBe(true);
  expect(sameSearch(route("?view=board", false, ALL), "?view=board")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=edit", false, ALL), "?view=board&region=cut")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=edit", false, landed("board")), "?view=board&region=cut")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=edit", false, NONE), "?suite=particl&page=edit")).toBe(true);
  expect(sameSearch(route("?view=board&list=1&kind=studio", true, NONE), "?suite=particl&page=rig&rig=list")).toBe(true);
});

test("Ads and Social boards need the board too; without both, Ads' addresses open today's Business pages", () => {
  const adsOnly = landed("board-ads");
  expect(isLanded("board-ads", adsOnly)).toBe(false);
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=hooks", true, adsOnly), "?suite=moleculr&page=marketing&sp=hooks")).toBe(true);
  expect(sameSearch(route("?view=board&kind=ads&frame=2", true, adsOnly), "?suite=moleculr&page=marketing&sp=dtc")).toBe(true);
  expect(sameSearch(route("?view=board&kind=social", true, landed("board")), "?suite=subatomik&page=history")).toBe(true);
  const both = landed("board", "board-ads");
  expect(isLanded("board-ads", both)).toBe(true);
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=dtc", true, both), "?view=board&kind=ads&frame=2&card=image-ad")).toBe(true);
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=design&sp=design", true, both), "?view=board&kind=ads&frame=3")).toBe(true);
  expect(sameSearch(route("?suite=moleculr&page=marketing&sp=brand", true, both), "?view=board&kind=ads&frame=1&card=brand")).toBe(true);
  /* Ads landed, Social not: a Social address opens today's page. */
  expect(sameSearch(route("?view=board&kind=social", true, both), "?suite=subatomik&page=history")).toBe(true);
});

test("Home: the Studio overview opens it once landed; a bare landing does too; before that, the overview", () => {
  const home = landed("home");
  expect(sameSearch(route("?suite=particl&page=brief&sp=stages", true, home), "?view=home")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=brief&sp=stages&project=ws-1", true, home), "?view=home&project=ws-1")).toBe(true);
  expect(sameSearch(route("?suite=particl&page=brief&sp=home", true, home), "?view=home")).toBe(true);
  expect(sameSearch(route("", true, home), "?view=home")).toBe(true);
  expect(sameSearch(route("?project=ws-1", true, home), "?view=home&project=ws-1")).toBe(true);
  /* A page that is named is not a bare landing. */
  expect(route("?suite=particl&page=brief", true, home)).toBe("?suite=particl&page=brief");
  expect(route("?make=image", true, home)).toBe("?make=image");
  expect(route("?view=workspace&tab=credits", true, home)).toBe("?view=workspace&tab=credits");
  /* Not landed, or off: today's Studio overview, and a bare landing stays bare. */
  expect(sameSearch(route("?view=home", true, NONE), "?suite=particl&page=brief&sp=stages")).toBe(true);
  expect(sameSearch(route("?view=home", false, home), "?suite=particl&page=brief&sp=stages")).toBe(true);
  expect(route("", true, NONE)).toBe("");
  expect(route("", false, home)).toBe("");
});

test("Atomik: the Agent page is the panel over Home once landed; `atomik=` is the old Agent page before that", () => {
  const both = landed("atomik", "home");
  expect(sameSearch(route("?suite=atomik&page=agent", true, both), "?view=home&atomik=1")).toBe(true);
  expect(sameSearch(route("?suite=atomik&page=agent", true, landed("atomik")), "?atomik=1")).toBe(true);
  expect(sameSearch(route("?atomik=how&q=hi", true, NONE), "?suite=atomik&page=agent&q=hi")).toBe(true);
  expect(sameSearch(route("?atomik=1", false, ALL), "?suite=atomik&page=agent")).toBe(true);
  expect(atomikAt("?atomik=1", true, both)).toBe("panel");
  expect(atomikAt("?atomik=how", true, both)).toBe("how");
  expect(atomikAt("?atomik=1", false, both)).toBeNull();
  expect(atomikAt("?atomik=1", true, NONE)).toBeNull();
  expect(atomikAt("?atomik=nope", true, both)).toBeNull();
});

test("the control room keeps its four addresses; Workspace's Dashboard is Activity", () => {
  const cr = landed("control-room");
  for (const url of ["?suite=atomik&page=approvals", "?suite=atomik&page=runs", "?suite=atomik&page=agent&sp=memory", "?suite=atomik&page=agent&sp=saved-skills"]) {
    expect(sameSearch(route(url, true, cr), url), url).toBe(true);
    expect(screenAt(url, true, cr), url).toBe("control-room");
    expect(screenAt(url, true, NONE), url).toBeNull();
    expect(screenAt(url, false, cr), url).toBeNull();
  }
  expect(sameSearch(route("?view=workspace&tab=dashboard", true, cr), "?suite=atomik&page=runs")).toBe(true);
  expect(sameSearch(route("?view=workspace&tab=dashboard", true, NONE), "?view=workspace&tab=dashboard")).toBe(true);
  expect(screenAt("?suite=atomik&page=budget", true, cr)).toBeNull();
});

test("the phone: compact widths, or `device=phone` at any width; switch on and landed only", () => {
  const phone = landed("phone");
  expect(phoneAt("", true, true, phone)).toEqual({ on: true, framed: false });
  expect(phoneAt("", true, false, phone)).toEqual({ on: false, framed: false });
  expect(phoneAt("?device=phone", true, false, phone)).toEqual({ on: true, framed: true });
  expect(phoneAt("?device=phone", true, true, phone)).toEqual({ on: true, framed: false });
  expect(phoneAt("?device=phone", false, true, phone)).toEqual({ on: false, framed: false });
  expect(phoneAt("?device=phone", true, true, NONE)).toEqual({ on: false, framed: false });
  expect(phoneAt({ device: "phone" }, true, false, phone).framed).toBe(true);
});

test("which screen an address mounts: only with the switch on, only once landed", () => {
  expect(screenAt("?view=home", true, landed("home"))).toBe("home");
  expect(screenAt("?view=home", false, ALL)).toBeNull();
  expect(screenAt("?view=home", true, NONE)).toBeNull();
  expect(screenAt("?view=board&kind=ads", true, ALL)).toBe("board-ads");
  expect(screenAt("?view=board&kind=social", true, ALL)).toBe("board-social");
  expect(screenAt("?view=board&kind=ads", true, landed("board"))).toBe("board");
  expect(screenAt("?view=board", true, landed("board"))).toBe("board");
  expect(screenAt("?view=board", true, landed("board-ads"))).toBeNull();
  expect(screenAt("?view=workspace&tab=team", true, landed("settings"))).toBe("settings");
  expect(screenAt("?view=workspace&tab=team", true, NONE)).toBeNull();
  expect(screenAt("?view=crew&cp=room", true, ALL)).toBeNull();
});

test("a result is final, in every case: routing a routed address changes nothing (no chains)", () => {
  for (const [name, screens] of SETS) {
    for (const on of [false, true]) {
      for (const url of EVERY_ADDRESS) {
        const once = route(url, on, screens);
        const twice = route(once, on, screens);
        expect(sameSearch(twice, once), `${url} → ${once} → ${twice} (${name}, ${on ? "on" : "off"})`).toBe(true);
      }
    }
  }
});

test("every param rides along, whichever way an address moves", () => {
  const carried = "project=ws-1&asset=generation%3Agen_1&sel=shot%3As1&find=1&production=prod_7&import=board_3&higgsfield=1";
  for (const [name, screens] of SETS) {
    for (const on of [false, true]) {
      for (const url of [...appForms, ...designForms]) {
        const own = new URLSearchParams(url);
        /* Viral's two tools become Make's, which drops the shell's own `sel` (lib/shell/make.ts › fromViralLink, as D0 has it). */
        const extra = Object.fromEntries([...new URLSearchParams(carried)].filter(([k]) => !own.has(k) && !(k === "sel" && (own.get("page") === "rig" || fromMakeLink(normalize(url))))));
        const out = params(route(`${url || "?"}${url ? "&" : ""}${new URLSearchParams(extra)}`, on, screens));
        for (const [key, value] of Object.entries(extra)) expect(out[key], `${url} keeps ${key} (${name}, ${on ? "on" : "off"})`).toBe(value);
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
          const mounted = screenAt(row.to, true, screens) ?? (atomikAt(row.to, true, screens) ? "atomik" : null);
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
    const moved = !sameSearch(route(p.from, true, ALL), p.from);
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

test("each module's params are kept with the switch on; with it off only the board's are, beside today's", () => {
  /* With the switch off the shell keeps today's params and the board's alone (one board for everyone), never Home's, Atomik's or the phone's. */
  const off = shellParams(false);
  for (const key of SHELL_PARAMS) expect(off).toContain(key);
  for (const key of ["kind", "frame", "list", "region", "drawer", "review", "card", "start"]) expect(off, key).toContain(key);
  for (const key of ["atomik", "screen", "device", "run", "take"]) expect(off, key).not.toContain(key);
  const on = shellParams(true);
  for (const key of SHELL_PARAMS) expect(on).toContain(key);
  for (const key of ["kind", "frame", "list", "region", "drawer", "review", "card", "atomik", "q", "screen", "device", "from", "run", "take", "open", "start"]) expect(on, key).toContain(key);
  /* `settings` and `palette` are one-shot: read on landing, never kept. */
  expect(on).not.toContain("settings");
  expect(on).not.toContain("palette");
  expect(new Set(on).size).toBe(on.length);
  expect(screenParams(SCREENS).sort()).toEqual([...new Set(SCREENS.flatMap((s) => [...s.params]))].sort());
});

test("rows match as a subset, the most specific wins, and a page's sub-params leave with it", () => {
  const rows = [{ from: "?a=1", to: "?x=1" }, { from: "?a=1&b=2", to: "?x=2" }, { from: "?a=1&b=3", to: "?x=3" }];
  expect(matchRow("?a=1&b=2&c=9", rows)).toEqual(rows[1]);
  expect(matchRow("?a=1", rows)).toEqual(rows[0]);
  expect(matchRow("?b=2", rows)).toBeNull();
  expect(applyRows("?a=1&b=2&c=9", rows)).toBe("?c=9&x=2");
  expect(applyRows("?z=1", rows)).toBeNull();
  expect(applyRows("?suite=particl&page=brief&sp=brief&rig=list&keep=1", [{ from: "?suite=particl&page=brief", to: "?view=board" }])).toBe("?keep=1&view=board");
  /* A row back to an old page takes the new screen's params with it, but never one the row itself sets. */
  expect(applyRows("?view=board&region=cut&kind=studio&keep=1", [{ from: "?view=board&region=cut", to: "?suite=particl&page=edit" }], ["view", "kind", "region"])).toBe("?keep=1&suite=particl&page=edit");
});

test("normalize stays idempotent, and the spelling step never changes an address the shell serves today", () => {
  for (const url of [...appForms, ...designForms]) {
    const once = spelling(url);
    expect(spelling(once), url).toBe(once);
    expect(sameSearch(spelling(url), fromMakeLink(normalize(url)) ?? normalize(url)), url).toBe(true);
  }
});
