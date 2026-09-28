import { test, expect } from "@playwright/test";
import { renderedSubject } from "../../lib/workspace/take-subject";

/**
 * Who Rig's "rendered" toast is about. The composer names the shot it files a
 * take on with the prompt cut at 60 characters (lib/workspace/use-composer.ts:
 * `prompt.trim().slice(0, 60)`, trimmed again by shotPatch), and a prompt is
 * never the subject of a sentence ("…desk lamp in rendered."): that take is
 * "Your take", as the composer's own toast says. A shot's own title stays.
 */
const composerShot = (prompt: string) => ({ title: prompt.trim().slice(0, 60).trim(), note: prompt.trim() });

test("a shot the composer named with its prompt is 'Your take', cut or whole", () => {
  const long = composerShot("A slow, cinematic push in on a battered scuffed desk lamp in a dark study, dust in the beam");
  expect(long.title).toBe("A slow, cinematic push in on a battered scuffed desk lamp in");
  expect(renderedSubject(long.title, long.note)).toBe("Your take");
  /* A cut that ended on a space was trimmed by shotPatch: still the prompt's own start. */
  const spaced = composerShot("A slow, cinematic push in on a tarnished brass desk lamp in a dark study, dust in the beam");
  expect(spaced.title.length).toBe(59);
  expect(renderedSubject(spaced.title, spaced.note)).toBe("Your take");
  /* A short prompt is the whole name, full stop and all ("…grey sky. rendered."). */
  const short = composerShot("A red lighthouse under a flat grey sky.");
  expect(renderedSubject(short.title, short.note)).toBe("Your take");
});

test("a shot's own title stays, even one its note starts with", () => {
  expect(renderedSubject("Opening wide", "Wide. Hold still.")).toBe("Opening wide");
  expect(renderedSubject("Wide", "Wide. Hold still.")).toBe("Wide");
  expect(renderedSubject("  Departure ", "Wide again.")).toBe("Departure");
  /* No note to compare with (the shot is gone from the draft): the title as it was. */
  expect(renderedSubject("Shot 03", "")).toBe("Shot 03");
});

test("a shot with no title is 'Your take'", () => {
  expect(renderedSubject("", "Wide. Hold still.")).toBe("Your take");
  expect(renderedSubject("   ", "")).toBe("Your take");
});
