import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { safeNext } from "../../lib/safeNext";
import { signInHrefFor } from "../../lib/signIn";

const ORIGIN = "https://app.particl.test";

/** Every shape of an attempt to make `/login?next=<address>` an open redirect. Each must come out as "/". */
const HOSTILE = [
  "https://evil.test", "http://evil.test/path", "//evil.test", "///evil.test", "////evil.test/x", "/\\evil.test", "\\\\evil.test", "\\/evil.test",
  "/\\/evil.test", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "evil.test", "evil.test/path",
  "https:evil.test", "https:/evil.test", "https://app.particl.test@evil.test", "https://app.particl.test.evil.test", " //evil.test", "\t//evil.test", "/\t/evil.test",
  "/\n/evil.test", "/\r/evil.test", "//\u0000evil.test", "\u0000/evil.test", "/.//evil.test", "/a/..//evil.test", "/./\\evil.test", "/%5C/evil.test/../x//y",
  "//evil.test/%2e%2e", "https://app.particl.test/ok", "mailto:a@evil.test", "tel:1", "file:///etc/passwd", "ftp://evil.test", "?x=1", "#x", "ok", "",
  " /ok", "/ok ",
];

test("a hostile next is never kept, in the browser (with the page's origin) or on the server (without)", () => {
  for (const raw of HOSTILE) {
    for (const origin of [ORIGIN, null]) {
      const got = safeNext(raw, origin);
      /* Either refused, or (for a path that merely looks odd, like "/%5C/evil.test/../x//y") resolved to a path on this origin. */
      expect(got.startsWith("/"), `${JSON.stringify(raw)} → ${got}`).toBe(true);
      expect(/^\/[\\/]/.test(got), `${JSON.stringify(raw)} → ${got} must not read as another host`).toBe(false);
      expect(new URL(got, ORIGIN).origin, `${JSON.stringify(raw)} → ${got}`).toBe(ORIGIN);
    }
  }
  for (const raw of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "/.//evil.test", "/a/..//evil.test", "\t//evil.test", " //evil.test"])
    expect(safeNext(raw, ORIGIN), JSON.stringify(raw)).toBe("/");
});

test("a path on this origin is kept, with its query and hash", () => {
  for (const next of ["/", "/suites", "/suites?make=video&view=home", "/suites?project=p1&view=board&region=cast", "/account/security", "/suites?asset=generation%3Aabc", "/signup?invite=CODE-1", "/billing?new=1#plans"]) {
    expect(safeNext(next, ORIGIN), next).toBe(next);
    expect(safeNext(next, null), next).toBe(next);
  }
  expect(safeNext(null, ORIGIN)).toBe("/");
  expect(safeNext(undefined, null)).toBe("/");
});

test("every sign-in link the app builds names a path, and the sign-in form only follows safeNext", () => {
  for (const [path, query] of [["/suites", "make=video&view=home"], ["/generate", "mode=images&task=upscale"], ["/team", ""], ["/workbench", "stage=cast"]] as const) {
    const href = signInHrefFor(path, query);
    const next = new URL(href, ORIGIN).searchParams.get("next");
    expect(next, href).not.toBeNull();
    expect(safeNext(next, ORIGIN), href).toBe(next);
  }
  const form = readFileSync("components/WelcomeSignIn.tsx", "utf8");
  expect(form).toContain('import { safeNext } from "@/lib/safeNext"');
  /* The only reader of `next` is safeNext, and the only navigation after sign-in is to its answer. */
  expect(form.match(/get\("next"\)/g)).toHaveLength(1);
  expect(form).toContain('safeNext(params.get("next"),');
  expect(form).toContain("router.push(next)");
  expect(form.match(/router\.push\(/g)!.length).toBe(1);
});
