import { test, expect } from "@playwright/test";
import { cleanPrefs, wants, NOTIFY_DEFAULT, NOTIFY_KINDS, NOTIFY_LABELS } from "../../lib/notifyPrefs";

/** What a person wants to be told about, per workspace (brief 2.7). */
test("everything is on until someone says otherwise, and only real choices are read", () => {
  expect(cleanPrefs(null)).toEqual(NOTIFY_DEFAULT);
  expect(cleanPrefs("nonsense")).toEqual(NOTIFY_DEFAULT);
  expect(cleanPrefs({ takeDone: false, junk: true, capNear: "yes" })).toEqual({ ...NOTIFY_DEFAULT, takeDone: false });
  expect(NOTIFY_KINDS.every((k) => NOTIFY_LABELS[k].title.length > 0)).toBe(true);
});

test("a nudge reaches the people who asked for it, and an admin-only one never reaches a member", () => {
  const people = [
    { id: "owner", role: "owner" },
    { id: "admin", role: "admin", prefs: { capNear: false } },
    { id: "member", role: "member" },
    { id: "quiet", role: "admin", prefs: { takeDone: false, capNear: false, approvalNeeded: false, balanceLow: false, runNeedsYou: false } },
  ];
  expect(wants("takeDone", people)).toEqual(["owner", "admin", "member"]);
  expect(wants("capNear", people)).toEqual(["owner"]);              // the admin opted out, the member is not asked
  expect(wants("balanceLow", people)).toEqual(["owner", "admin"]);  // admin-only, and the quiet one opted out
  expect(wants("approvalNeeded", people)).toEqual(["owner", "admin", "member"]);
  /* An Atomik run that waits on the person who asked: anyone's, never admin-only. */
  expect(wants("runNeedsYou", people)).toEqual(["owner", "admin", "member"]);
  expect(NOTIFY_LABELS.runNeedsYou.adminOnly).toBeUndefined();
  expect(wants("takeDone", [])).toEqual([]);
});
