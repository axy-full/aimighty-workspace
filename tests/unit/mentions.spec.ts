import { test, expect } from "@playwright/test";
import { peopleIn, nicknames, splitMentions, isNamed } from "../../lib/mentions";

const team = [
  { id: "u1", name: "Ana Ruiz" },
  { id: "u2", name: "Sam Okafor" },
  { id: "u3", name: "Sam Delgado" },
];

/** A note names people (brief 2.1): full names always, a first name only when it is that person's alone. */
test("a note's names resolve to people, once each, and an ambiguous first name is left alone", () => {
  expect(nicknames(team).map((n) => n.name).sort()).toEqual(["Ana", "Ana Ruiz", "Sam Delgado", "Sam Okafor"]);
  expect(peopleIn("@Ana the 3rd one but with the pan slower", team).map((p) => p.id)).toEqual(["u1"]);
  expect(peopleIn("@Ana Ruiz and @Sam Okafor please look", team).map((p) => p.id)).toEqual(["u1", "u2"]);
  expect(peopleIn("@Ana and @Ana Ruiz again", team).map((p) => p.id)).toEqual(["u1"]);
  expect(peopleIn("@Sam which one?", team)).toEqual([]);
  expect(peopleIn("@Nobody here", team)).toEqual([]);
  expect(peopleIn("no names at all", team)).toEqual([]);
});

test("only a name the note resolved reads as a mention", () => {
  const parts = splitMentions("@Ana the pan is slow, ask @Sam Okafor", ["Ana", "Sam Okafor"]);
  expect(parts.map((p) => p.text)).toEqual(["@Ana", " the pan is slow, ask ", "@Sam Okafor"]);
  expect(parts.filter((p) => isNamed(p, ["Ana", "Sam Okafor"])).length).toBe(2);
  // An address is not a mention, however it is split.
  const mail = splitMentions("write to me@example.com", ["Ana"]);
  expect(mail.some((p) => isNamed(p, ["Ana"]))).toBe(false);
  expect(isNamed({ text: "@Ana", mention: true }, ["ana"])).toBe(true);
  expect(isNamed({ text: "plain", mention: false }, ["plain"])).toBe(false);
});
