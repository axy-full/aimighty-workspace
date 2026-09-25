import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import Boundary, { type Fault } from "../../components/Boundary";
import { HEADER_SEGMENT } from "../../lib/shell/ia";
import {
  CRASH_PROBE, FIND_HREF, STUDIO_HREF, TAKES_HREF,
  faultMessage, faultPrimary, faultRef, faultReport, findRequested, isStaleBuild, probeArmed, segmentHref, throwIfArmed, withoutFind,
} from "../../lib/shell/fault";

/**
 * Error boundaries per panel in the Suites shell (lib/shell/fault.ts,
 * components/Boundary.tsx): the ref a person can quote, when the cure is a
 * reload, what "Copy details" carries, the ways back in from a page outside the
 * shell, the development-only crash probes — and the source-level promises the
 * browser spec (tests/hf-error-boundaries-workbench.spec.ts) cannot see from a
 * single viewport: every panel is walled off, and no error page drops under
 * the 12px floor or points at a legacy destination.
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
  test("Studio, Takes and Search are Suites destinations, not legacy ones", () => {
    expect(STUDIO_HREF).toBe("/suites");
    expect(TAKES_HREF).toBe("/suites?page=takes&sp=takes");
    expect(FIND_HREF).toBe("/suites?find=1");
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

  test("dead in production: no global can arm one on the live site", () => {
    const env = process.env as Record<string, string | undefined>;
    const before = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(probeArmed("library", { [CRASH_PROBE]: ["library"] })).toBe(false);
    } finally {
      env.NODE_ENV = before;
    }
  });
});

test.describe("Boundary", () => {
  type Props = ConstructorParameters<typeof Boundary>[0];
  /* Drives the class directly: setState applied synchronously, as React would after a commit. */
  function mount(props: Partial<Props>) {
    let seen: Fault | null = null;
    const boundary = new Boundary({ children: "the panel", what: "The Library", fallback: (fault: Fault) => { seen = fault; return "fallback"; }, ...props } as Props);
    boundary.setState = ((update: unknown) => {
      const patch = typeof update === "function" ? (update as (s: typeof boundary.state) => object)(boundary.state) : update;
      boundary.state = { ...boundary.state, ...(patch as object) };
    }) as typeof boundary.setState;
    const fail = (error: Error) => { boundary.state = { ...boundary.state, ...Boundary.getDerivedStateFromError(error) }; };
    return { boundary, fail, fault: () => seen as Fault | null };
  }

  test("hands its fallback the error, the same ref the console line carries, and a retry that counts", () => {
    const { boundary, fail, fault } = mount({});
    expect(boundary.render()).toBe("the panel");
    const error = new Error("Crash probe: library");
    fail(error);
    expect(boundary.render()).toBe("fallback");
    expect(fault()).toMatchObject({ error, ref: faultRef(error), what: "The Library", attempts: 0 });

    /* Try again while it still throws: the attempt is counted, so the card can offer Reload. */
    fault()!.retry();
    expect(boundary.render()).toBe("the panel");
    fail(error);
    boundary.render();
    expect(fault()!.attempts).toBe(1);
    expect(faultPrimary(error, fault()!.attempts)).toBe("retry");
    fault()!.retry();
    fail(error);
    boundary.render();
    expect(faultPrimary(error, fault()!.attempts)).toBe("reload");
  });

  test("a new resetKey is a fresh go: the failure and the attempt count clear", () => {
    const { boundary, fail, fault } = mount({ resetKey: "brief" });
    fail(new Error("boom"));
    boundary.render();
    fault()!.retry();
    fail(new Error("boom"));
    expect(boundary.state.attempts).toBe(1);
    const previous = boundary.props;
    (boundary as unknown as { props: Props }).props = { ...previous, resetKey: "beats" };
    boundary.componentDidUpdate(previous);
    expect(boundary.state).toEqual({ error: null, attempts: 0 });
    expect(boundary.render()).toBe("the panel");
  });

  test("the same resetKey keeps the failure on screen", () => {
    const { boundary, fail } = mount({ resetKey: "brief" });
    fail(new Error("boom"));
    boundary.componentDidUpdate(boundary.props);
    expect(boundary.render()).toBe("fallback");
  });

  test("the default card shows the ref at 12px, not the 11.5px it used to", () => {
    const { boundary, fail } = mount({ fallback: undefined });
    fail(new Error("boom"));
    const card = boundary.render() as ReactElement;
    const text = JSON.stringify(card, (key, value) => (key === "_owner" || key === "_store" ? undefined : value));
    expect(text).toContain("text-[12px]");
    expect(text).not.toContain("11.5px");
    expect(text).toContain(`"ref ","${faultRef(new Error("boom"))}"`);
  });
});

test.describe("the shell's walls, in source", () => {
  const shell = read("components/graphite/SuitesShell.tsx");

  test("every stage body, the Library, the Inspector, Gen, Crew, Workspace, search, the strip and the composer have their own boundary", () => {
    for (const probe of ["stageProbe", '"library"', '"inspector"', '"gen"', '"crew"', '"workspace"', '"palette"', '"strip"', '"composer"']) {
      expect(shell, probe).toMatch(new RegExp(`<Boundary [^>]*probe=\\{?${probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}?`));
    }
    /* Moving to another stage, project or selection resets the wall. */
    expect(shell).toContain("resetKey={stageKey}");
    expect(shell).toMatch(/const stageKey = `\$\{shell\.suite\.id\}:\$\{shell\.page\.id\}:\$\{project\?\.id \?\? ""\}`/);
  });

  test("Gen walls off its results and each take", () => {
    const gen = read("components/graphite/GenView.tsx");
    expect(gen).toMatch(/<Boundary what="Results" probe="gen-results"/);
    expect(gen).toMatch(/<Boundary what="This take" probe=\{`take:\$\{entry\.take\.id\}`\}/);
  });

  test("the Suites segment has its own error page, and it keeps the header", () => {
    const page = read("app/suites/error.tsx");
    expect(page).toMatch(/^"use client";/);
    expect(page).toContain('<FaultPage kind="error"');
    const faultPage = read("components/graphite/FaultPage.tsx");
    expect(faultPage).toContain("<StaticHeader />");
    expect(faultPage).toContain("Back to Studio");
    expect(faultPage).toContain("Open Takes");
  });
});

test("no error page drops under the 12px floor or sends people to a legacy destination", () => {
  for (const path of ["app/error.tsx", "app/(app)/error.tsx", "app/global-error.tsx", "app/not-found.tsx", "components/Boundary.tsx", "components/graphite/PanelFault.tsx", "components/graphite/FaultPage.tsx", "app/fault.css"]) {
    const source = read(path);
    expect(source, path).not.toMatch(/text-\[(\d|1[01])(\.\d+)?px\]/);
    expect(source, path).not.toMatch(/font-size:\s*(\d|1[01])(\.\d+)?px/);
    expect(source, path).not.toMatch(/Go to Video|href="\/all"|href="\/productions"/);
  }
});
