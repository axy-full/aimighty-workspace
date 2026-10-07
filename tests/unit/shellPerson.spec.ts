import { expect, test } from "@playwright/test";
import { avatarInitials, looksLikeId, personLine, readableName, workspaceLine } from "@/lib/shell/person";

/* The avatar menu names a person and "workspace · role" (design README § 1); an id or a "Browser …" placeholder is never shown as a name. */

test("a name that is really an id is not a name", () => {
  for (const id of ["y_AD14WC77MG9aHYEi7qvdd6", "Browser y_AD14WC77MG9aHYEi7qvdd6", "0b7f1c52-7c4e-4a3b-9d1e-2f6a8b9c0d1e", "ws_4f9a1c", "acct-0042x1", "  "]) {
    expect(looksLikeId(id), id).toBe(true);
    expect(readableName(id), id).toBeNull();
  }
  for (const name of ["Ada Rowan", "Harbour Studio", "Studio 54", "Nina", "ada@example.test"]) {
    expect(looksLikeId(name), name).toBe(false);
    expect(readableName(name)).toBe(name);
  }
});

test("the menu's two lines", () => {
  expect(personLine({ name: "Ada Rowan", email: "ada@example.test" })).toBe("Ada Rowan");
  expect(personLine({ name: "y_AD14WC77MG9aHYEi7qvdd6", email: "ada@example.test" })).toBe("ada@example.test");
  expect(personLine({ name: null, email: null })).toBe("Your account");
  expect(workspaceLine("Harbour Studio", "owner")).toBe("Harbour Studio · owner");
  expect(workspaceLine("Browser y_AD14WC77MG9aHYEi7qvdd6", "admin")).toBe("Your workspace · admin");
  expect(workspaceLine(undefined, null)).toBe("Your workspace");
});

test("the avatar carries the person's initials, then the workspace's, then P", () => {
  expect(avatarInitials({ name: "Ada Rowan" }, "Harbour Studio")).toBe("AR");
  expect(avatarInitials({ name: null }, "Harbour Studio")).toBe("HS");
  expect(avatarInitials({ name: "y_AD14WC77MG9aHYEi7qvdd6" }, "Browser y_AD14WC77MG9aHYEi7qvdd6")).toBe("P");
});
