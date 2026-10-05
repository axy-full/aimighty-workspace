import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The seams between streams, held where they are wired (the integration lane). Each reads the shell's source because the
 * wiring lives in one React component; the browser spec tests/demo-int-seams-workbench.spec.ts holds the behaviour.
 */
const read = (file: string) => readFileSync(join(__dirname, "..", "..", file), "utf8");
const shell = read("components/graphite/SuitesShell.tsx");

test("seam b: the phone's own screens never share the page with the desktop's Make panel or Atomik's panel", () => {
  expect(shell).toMatch(/\{shell\.make && !phoneOn \? \(/);
  expect(shell).toMatch(/\{!phoneOn \? <AtomikMount ctx=\{screenCtx\} \/> : null\}/);
  /* phoneOn is declared before the JSX that reads it. */
  expect(shell.indexOf("const phoneOn = shell.phone.on;")).toBeGreaterThan(0);
  expect(shell.indexOf("const phoneOn = shell.phone.on;")).toBeLessThan(shell.indexOf("shell.make && !phoneOn"));
});
