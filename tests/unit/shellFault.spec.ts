import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultFault, type Fault } from "../../components/Boundary";
import { HEADER_SEGMENT } from "../../lib/shell/ia";
import {
  CRASH_PROBE, FIND_HREF, HOME_HREF, STUDIO_HREF, TAKES_HREF,
  asError, attemptsFor, countTry, faultMessage, faultPrimary, faultRef, faultReport, findRequested, isStaleBuild, probeArmed, segmentHref, throwIfArmed, withoutFind,
  type Tries,
} from "../../lib/shell/fault";

/**
 * Error boundaries per panel in the Suites shell (lib/shell/fault.ts,
 * components/Boundary.tsx): the ref a person can quote, when the cure is a
 * reload, what "Copy details" carries, the Try again count, the ways back in
 * from a page outside the shell, the development-only crash probes — and the
 * source-level promises the browser spec (tests/hf-error-boundaries-workbench.spec.ts)
 * cannot see from a single viewport: every panel is walled off with Next's own
 * catchError, and no error page drops under the 12px floor or points at a
 * legacy destination.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test.describe("faultRef", () => {
  test("Next's digest wins, trimmed and capped", () => {
    expect(faultRef({ message: "boom", digest: " 3129475640 " })).toBe("3129475640");
    expect(faultRef({ message: "boom", digest: "x".repeat(80) })).toHaveLength(32);
  });

  test("without a digest the same failure gets the same short ref, and different failures differ", () => {
    const a = faultRef(new Error("Cannot read properties of undefined (reading 'id')"));
    expect(a).toMatch(/^P-[0-9A-Z]{7}$/);
    expect(faultRef(new Error("Cannot read properties of undefined (reading 'id')"))).toBe(a);
    expect(faultRef(new Error("Cannot read properties of undefined (reading 'name')"))).not.toBe(a);
    expect(faultRef(new TypeError("same text"))).not.toBe(faultRef(new RangeError("same text")));
  });

  test("an empty or missing error still has a ref", () => {
    expect(faultRef(null)).toMatch(/^P-[0-9A-Z]{7}$/);
    expect(faultRef({ digest: "   " })).toMatch(/^P-[0-9A-Z]{7}$/);
  });
});

test("asError: whatever a render throws becomes an Error the card can read", () => {
  const real = new TypeError("boom");
  expect(asError(real)).toBe(real);
  expect(asError("plain words").message).toBe("plain words");
  const shaped = asError({ name: "LibraryError", message: "no rows", digest: "d42" });
  expect(shaped).toBeInstanceOf(Error);
  expect([shaped.name, shaped.message, shaped.digest]).toEqual(["LibraryError", "no rows", "d42"]);
  /* Nothing usable: an empty message, so the card shows the ref alone. */
  for (const thrown of [undefined, null, 42, {}]) {
    const error = asError(thrown);
    expect(error).toBeInstanceOf(Error);
    expect(faultMessage(error)).toBeNull();
    expect(faultRef(error)).toMatch(/^P-[0-9A-Z]{7}$/);
  }
});

test("a newer deploy is a reload, not a bug", () => {
  expect(isStaleBuild({ name: "ChunkLoadError", message: "Loading chunk 812 failed." })).toBe(true);
  expect(isStaleBuild(new Error("Loading CSS chunk app/suites/page failed"))).toBe(true);
  expect(isStaleBuild(new TypeError("Failed to fetch dynamically imported module: https://x/_next/a.js"))).toBe(true);
  expect(isStaleBuild(new TypeError("Importing a module script failed."))).toBe(true);
  expect(isStaleBuild(new Error("Cannot read properties of undefined"))).toBe(false);
  expect(isStaleBuild(null)).toBe(false);
});

test("faultMessage: one line, capped, and nothing when production hid it", () => {
  expect(faultMessage(new Error("  line one\n\n   line two  "))).toBe("line one line two");
  const long = faultMessage(new Error("a".repeat(300)), 40)!;
  expect(long).toHaveLength(40);
  expect(long.endsWith("…")).toBe(true);
  expect(faultMessage(new Error(""))).toBeNull();
  expect(faultMessage(null)).toBeNull();
  expect(faultMessage(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details."))).toBeNull();
});

test("faultPrimary: Try again twice, then Reload — and Reload at once for a stale build", () => {
  const bug = new Error("boom");
  expect(faultPrimary(bug)).toBe("retry");
  expect(faultPrimary(bug, 1)).toBe("retry");
  expect(faultPrimary(bug, 2)).toBe("reload");
  expect(faultPrimary({ name: "ChunkLoadError", message: "Loading chunk 9 failed." }, 0)).toBe("reload");
});

test("Try again is counted per resetKey: another page, project or take starts from none", () => {
  let tries: Tries = { key: "studio:brief:p1", count: 0 };
  expect(attemptsFor(tries, "studio:brief:p1")).toBe(0);
  tries = countTry(tries, "studio:brief:p1");
  tries = countTry(tries, "studio:brief:p1");
  expect(attemptsFor(tries, "studio:brief:p1")).toBe(2);
  expect(faultPrimary(new Error("boom"), attemptsFor(tries, "studio:brief:p1"))).toBe("reload");
  /* Moving on is a fresh go, and pressing there counts from one. */
  expect(attemptsFor(tries, "studio:beats:p1")).toBe(0);
  expect(countTry(tries, "studio:beats:p1")).toEqual({ key: "studio:beats:p1", count: 1 });
  /* A boundary with no resetKey counts all the same. */
  expect(attemptsFor(countTry({ key: undefined, count: 0 }, undefined), undefined)).toBe(1);
});

test("faultReport: what, ref, message, where and when — and nothing about the person", () => {
  const error = new Error("Crash probe: library");
  const text = faultReport({ what: "The Library", error, where: "/suites?sp=brief", at: Date.UTC(2026, 8, 25, 12, 0, 0) });
  expect(text).toBe([
    "Particl · The Library stopped",
    `ref ${faultRef(error)}`,
    "message Crash probe: library",
    "where /suites?sp=brief",
    "when 2026-09-25T12:00:00.000Z",
  ].join("\n"));
  /* A hidden server message and no location leave those lines out rather than printing blanks. */
  const hidden = faultReport({ what: "The Suites shell", error: { message: "omitted in production builds", digest: "42" }, at: 0 });
  expect(hidden).toBe("Particl · The Suites shell stopped\nref 42\nwhen 1970-01-01T00:00:00.000Z");
});

test.describe("the ways back in", () => {
  test("Studio, Takes and Search are Suites destinations, not legacy ones; a visitor goes to the front page", () => {
    expect(STUDIO_HREF).toBe("/suites");
    expect(TAKES_HREF).toBe("/suites?page=takes&sp=takes");
    expect(FIND_HREF).toBe("/suites?find=1");
    expect(HOME_HREF).toBe("/");
  });

  test("every header segment has a plain link that lands on it", () => {
    expect(Object.fromEntries(HEADER_SEGMENT.map((s) => [s.id, segmentHref(s.id)]))).toEqual({
      studio: "/suites",
      gen: "/suites?view=gen",
      business: "/suites?suite=moleculr",
      viral: "/suites?suite=subatomik",
      atomik: "/suites?suite=atomik",
      crew: "/suites?view=crew",
    });
  });

  test("?find=1 opens search once: it is read, then dropped with every other param kept", () => {
    expect(findRequested("?find=1")).toBe(true);
    expect(findRequested("?sp=takes&find=1")).toBe(true);
    expect(findRequested("?find=0")).toBe(false);
    expect(findRequested("")).toBe(false);
    expect(withoutFind("?find=1")).toBe("");
    expect(withoutFind("?sp=takes&find=1&project=p1")).toBe("?sp=takes&project=p1");
    expect(withoutFind("?sp=takes")).toBe("?sp=takes");
  });
});

test.describe("crash probes", () => {
  test("armed by name on the given scope only", () => {
    const scope = { [CRASH_PROBE]: ["library", "take:generation:g1"] };
    expect(probeArmed("library", scope)).toBe(true);
    expect(probeArmed("take:generation:g1", scope)).toBe(true);
    expect(probeArmed("inspector", scope)).toBe(false);
    expect(probeArmed("library", {})).toBe(false);
    expect(probeArmed("library", { [CRASH_PROBE]: "library" }), "a string is not a list").toBe(false);
    expect(probeArmed("library", null)).toBe(false);
    expect(() => throwIfArmed("library", scope)).toThrow("Crash probe: library");
    expect(() => throwIfArmed("inspector", scope)).not.toThrow();
  });

  test("an entry can name the error to throw: a long message, or a stale build", () => {
    const scope = { [CRASH_PROBE]: [{ name: "stage:boards", errorName: "ChunkLoadError", message: "Loading chunk 812 failed." }, { name: "library" }, { message: "no name" }] };
    expect(probeArmed("stage:boards", scope)).toBe(true);
    let thrown: unknown = null;
    try { throwIfArmed("stage:boards", scope); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ChunkLoadError");
    expect(isStaleBuild(thrown as Error)).toBe(true);
    expect(() => throwIfArmed("library", scope)).toThrow("Crash probe: library");
    expect(probeArmed("no name", scope)).toBe(false);
  });

  test("dead in production: no global can arm one on the live site", () => {
    const env = process.env as Record<string, string | undefined>;
    const before = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(probeArmed("library", { [CRASH_PROBE]: ["library"] })).toBe(false);
      expect(() => throwIfArmed("library", { [CRASH_PROBE]: [{ name: "library", message: "x" }] })).not.toThrow();
    } finally {
      env.NODE_ENV = before;
    }
  });
});

test.describe("Boundary", () => {
  const fault = (over: Partial<Fault> = {}): Fault => ({ error: new Error("boom"), ref: faultRef(new Error("boom")), what: "This take", attempts: 0, retry: () => {}, pending: false, ...over });
  /* The unit runner compiles JSX to plain element objects, so the card is read as its element tree, not rendered. */
  const tree = (node: unknown) => JSON.stringify(node, (key, value) => (key === "_owner" || key === "_store" ? undefined : value));

  test("the default card: what stopped, the ref at 12px in a colour above the floor, and one Try again at 44px", () => {
    const card = tree(DefaultFault({ fault: fault() }));
    expect(card).toContain('"This take"," couldn’t be shown"');
    expect(card).toContain(`"ref ","${faultRef(new Error("boom"))}"," · boom"`);
    expect(card).toContain("text-[12px] text-dim");
    expect(card).not.toMatch(/11\.5px|text-mute/);
    expect(card.match(/"children":"Try again"/g), "one next step").toHaveLength(1);
    expect(card).toContain("chip mt-4 min-h-[44px]");
    expect(card).toContain('"role":"alert"');
  });

  test("while a Try again is on its way the button says so and stays focusable", () => {
    for (const compact of [false, true]) {
      const card = tree(DefaultFault({ fault: fault({ pending: true }), compact }));
      expect(card).toContain('"children":"Trying…"');
      expect(card).toContain('"aria-disabled":true');
      expect(card).not.toContain('"disabled":true');
    }
  });

  test("it is Next's catchError, not a hand-rolled class: Try again is retry(), and a new resetKey calls reset()", () => {
    const source = read("components/Boundary.tsx");
    expect(source).toMatch(/import \{ catchError, type ErrorInfo \} from "next\/error";/);
    expect(source).toContain("catchError(Caught)");
    expect(source).not.toMatch(/extends React\.Component|getDerivedStateFromError|componentDidCatch/);
    expect(source).toMatch(/startRetry\(\(\) => \{ onRetry\(\); retry\(\); \}\)/);
    expect(source).toMatch(/if \(!Object\.is\(caught\.key, resetKey\)\) reset\(\);/);
    /* The probe wrapper only exists outside production. */
    expect(source).toMatch(/probe && process\.env\.NODE_ENV !== "production" \? <Probe/);
  });
});

test.describe("the shell's walls, in source", () => {
  const shell = read("components/graphite/SuitesShell.tsx");

  test("every stage body, the Library, the Inspector, Gen, Crew, Workspace, search, the strip, the composer and Atomik have their own boundary", () => {
    for (const probe of ["stageProbe", '"library"', '"inspector"', '"gen"', '"crew"', '"workspace"', '"palette"', '"strip"', '"composer"', '"atomik-gate"', '"atomik-sheet"']) {
      expect(shell, probe).toMatch(new RegExp(`<Boundary [^>]*probe=\\{?${probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}?`));
    }
    /* Moving to another stage, project or selection resets the wall. */
    expect(shell).toContain("resetKey={stageKey}");
    expect(shell).toMatch(/const stageKey = `\$\{shell\.suite\.id\}:\$\{shell\.page\.id\}:\$\{project\?\.id \?\? ""\}`/);
    /* The dialogs a fault replaces are still dialogs, and take focus. */
    expect(shell.match(/className="gx-fault-dialog" role="dialog" aria-modal="true"/g)).toHaveLength(2);
  });

  test("Gen walls off its results and each take", () => {
    const gen = read("components/graphite/GenView.tsx");
    expect(gen).toMatch(/<Boundary what="Results" probe="gen-results"/);
    expect(gen).toMatch(/<Boundary what="This take" probe=\{`take:\$\{entry\.take\.id\}`\}.*<TileFault/);
  });

  test("the Suites segment has its own error page; it keeps the header and retries with retry()", () => {
    const page = read("app/suites/error.tsx");
    expect(page).toMatch(/^"use client";/);
    expect(page).toContain('<FaultPage kind="error" error={error} onRetry={retry} />');
    expect(page).not.toContain("reset");
    const faultPage = read("components/graphite/FaultPage.tsx");
    expect(faultPage).toContain("<StaticHeader member={member} />");
    expect(faultPage).toContain("Back to Studio");
    expect(faultPage).toContain("Open Takes");
  });

  test("the 404 stays static and light: it never reads the request, and its page loads only with a 404", () => {
    /* Next renders app/not-found.tsx into every page's tree: one request read makes /login, /pricing, /signup
       and the 404 itself render on demand, and a direct import preloads its stylesheets on every page. */
    const code = read("app/not-found.tsx").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/next\/headers|\bcookies\(|\bheaders\(|\bconnection\(|\bdraftMode\(|searchParams/);
    expect(code).toContain("<NotFoundView />");
    expect(code).not.toContain("FaultPage");
    const view = read("components/graphite/NotFoundView.tsx");
    expect(view).toMatch(/^"use client";/);
    expect(view).toContain('dynamic(() => import("./FaultPage")');
    /* Member or visitor is asked in the browser, and only a 401 from /api/me makes it the visitor page. */
    const page = read("components/graphite/FaultPage.tsx");
    expect(page).toContain('fetch("/api/me", { cache: "no-store"');
    expect(page).toContain("response.status === 401");
    expect(page).toMatch(/const \[member, setMember\] = useState\(true\);/);
    /* The Suites error page keeps a direct import: it must show when code failed to load. */
    expect(read("app/suites/error.tsx")).toContain('import { FaultPage } from "@/components/graphite/FaultPage";');
  });
});

test("every error page retries with retry(), never reset(): only retry() fetches the server's part again", () => {
  for (const path of ["app/error.tsx", "app/(app)/error.tsx", "app/global-error.tsx", "app/suites/error.tsx"]) {
    const source = read(path);
    expect(source, path).toMatch(/retry: \(\) => void/);
    expect(source, path).not.toMatch(/reset: \(\) => void|onClick=\{reset\}|retry \?\? reset|error, reset/);
  }
});

test("no error page drops under the 12px floor, under 44px targets, or sends people to a legacy destination", () => {
  for (const path of ["app/error.tsx", "app/(app)/error.tsx", "app/global-error.tsx", "app/not-found.tsx", "components/Boundary.tsx", "components/graphite/PanelFault.tsx", "components/graphite/FaultPage.tsx", "app/fault.css"]) {
    const source = read(path);
    expect(source, path).not.toMatch(/text-\[(\d|1[01])(\.\d+)?px\]/);
    expect(source, path).not.toMatch(/font-size:\s*(\d|1[01])(\.\d+)?px/);
    expect(source, path).not.toMatch(/Go to Video|href="\/all"|href="\/productions"/);
    /* The refs and lines a person reads: never the faint greys that composite under #7C7C84. */
    expect(source, path).not.toMatch(/text-mute|--gx-text-3\)|#767A82/);
    expect(source, path).not.toMatch(/h-\[38px\]/);
  }
});
