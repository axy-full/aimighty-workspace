import { test, expect } from "@playwright/test";
import {
  portKey, parsePort, isPinned, portFollows,
  attributesOf, primaryAttribute, slotFor, elementKind, castKind, isVisual,
  citedStills, versionsFromTakes, versionLine, versionNumber,
} from "../../lib/rig";

/* Rig (brief 3). The port is `elementId:attributeId:versionId`, and the two
   nulls in it are what tell an inherited wire from an override. */

test("a port reads out and back, and refuses what it cannot resolve", () => {
  expect(portKey({ elementId: "el1", attributeId: "at1", versionId: "v1" })).toBe("el1:at1:v1");
  expect(portKey({ elementId: "el1", attributeId: "at1", versionId: null })).toBe("el1:at1:");
  expect(portKey({ elementId: "el1", attributeId: null, versionId: null })).toBe("el1::");

  expect(parsePort("el1:at1:v1")).toEqual({ elementId: "el1", attributeId: "at1", versionId: "v1" });
  expect(parsePort("el1:at1:")).toEqual({ elementId: "el1", attributeId: "at1", versionId: null });
  expect(parsePort("el1::")).toEqual({ elementId: "el1", attributeId: null, versionId: null });

  // No element names nothing; a version without an attribute names nothing either.
  expect(parsePort(":at1:v1")).toBeNull();
  expect(parsePort("el1::v1")).toBeNull();
  expect(parsePort("el1:at1")).toBeNull();
  expect(parsePort("el1:at1:v1:extra")).toBeNull();
  expect(parsePort("el 1:at1:v1")).toBeNull();
  expect(parsePort(null)).toBeNull();
});

test("a pin is a version, and following current is not", () => {
  expect(isPinned({ elementId: "el1", attributeId: "at1", versionId: "v2" })).toBe(true);
  expect(isPinned({ elementId: "el1", attributeId: "at1", versionId: null })).toBe(false);
});

/* The predicate the impact panel counts with. Getting this wrong puts a wrong
   number on a button that spends money, so it is spelled out case by case. */
test("a change reaches the ports that follow it and no others", () => {
  const follows = { elementId: "el1", attributeId: "wardrobe", versionId: null };
  const pinnedToIt = { elementId: "el1", attributeId: "wardrobe", versionId: "v2" };
  const pinnedElsewhere = { elementId: "el1", attributeId: "wardrobe", versionId: "v1" };
  const otherAttribute = { elementId: "el1", attributeId: "face", versionId: null };
  const bundle = { elementId: "el1", attributeId: null, versionId: null };

  expect(portFollows(follows, "el1", "wardrobe", "v2")).toBe(true);
  expect(portFollows(pinnedToIt, "el1", "wardrobe", "v2")).toBe(true);
  expect(portFollows(pinnedElsewhere, "el1", "wardrobe", "v2")).toBe(false);
  expect(portFollows(otherAttribute, "el1", "wardrobe", "v2")).toBe(false);
  expect(portFollows(bundle, "el1", "wardrobe", "v2")).toBe(true);
});

/* The element has to be named. A bundle port carries no attribute, so without
   it every character wired whole would follow a change to somebody else's
   location, and the producer would be quoted for shots the change cannot
   reach. This is the case the first version of this file got wrong. */
test("a change never reaches another element, however the port is wired", () => {
  const bundle = { elementId: "el_workshop", attributeId: null, versionId: null };
  const follows = { elementId: "el_workshop", attributeId: "plate", versionId: null };

  expect(portFollows(bundle, "el_cass", "wardrobe", "v2")).toBe(false);
  expect(portFollows(follows, "el_cass", "wardrobe", "v2")).toBe(false);
  // And still reaches its own element's change.
  expect(portFollows(bundle, "el_workshop", "plate", "v2")).toBe(true);
});

test("an element is made of the attributes its kind has, and lands in one slot", () => {
  expect(attributesOf("character")).toEqual(["face", "hair", "wardrobe", "voice"]);
  expect(attributesOf("location")).toEqual(["plate"]);
  expect(attributesOf("prop")).toEqual(["turntable", "detail"]);
  expect(primaryAttribute("character")).toBe("face");
  expect(primaryAttribute("location")).toBe("plate");

  expect(slotFor("character")).toBe("character");
  expect(slotFor("location")).toBe("background");
  expect(slotFor("prop")).toBe("element");
  expect(slotFor("look")).toBe("look");

  // The cast calls a look a style; neither side has to learn the other's word.
  expect(elementKind("style")).toBe("look");
  expect(castKind("look")).toBe("style");
  expect(elementKind("location")).toBe("location");
  expect(elementKind("nonsense")).toBe("character");

  expect(isVisual("face")).toBe(true);
  expect(isVisual("voice")).toBe(false);
});

/* Reading a port out of a take made before any of this existed. The compiler
   wrote the mapping into the prompt itself, so the take says which photograph
   stood behind which name. */

const refs = (...ids: string[]) => ids.map((uploadId) => ({ uploadId, role: "reference_image", kind: "image" }));

test("a take names which upload stood behind each citation", () => {
  const compiled = "@Image1 walks into @Image2.\n\n@Image1 is Cass: a courier. @Image2 is Workshop: a lock-up.";
  expect(citedStills(compiled, refs("up_a", "up_b"))).toEqual([
    { name: "Cass", uploadId: "up_a" },
    { name: "Workshop", uploadId: "up_b" },
  ]);
});

test("nothing is inferred where the take did not say", () => {
  // No citation line: a cast member with no description never got one written.
  expect(citedStills("Cass walks in.", refs("up_a"))).toEqual([]);
  // The index points past the end of what was attached.
  expect(citedStills("@Image3 is Cass: a courier.", refs("up_a"))).toEqual([]);
  // A reference the person dragged in themselves shifts the index, and the
  // citation counts from the same place, so the right file is still found.
  expect(citedStills("@Image2 is Cass: a courier.", refs("mine", "up_a"))).toEqual([{ name: "Cass", uploadId: "up_a" }]);
});

/* The compiler always attaches cast stills last, in citation order, so the
   indices it hands out are consecutive and end at the last image. On the video
   path the stored prompt is the prompt writer's rewrite, and a model that
   renumbers a citation while rearranging a sentence would otherwise attach a
   name to the wrong photograph. A history that is missing can be filled in
   later. One that is wrong cannot be told from one that is right. */
test("a mapping that is not positionally sound is thrown away whole", () => {
  // Sound: two names on the last two of three images.
  expect(citedStills("@Image2 is Cass: a. @Image3 is Iver: b.", refs("mine", "up_a", "up_b")))
    .toEqual([{ name: "Cass", uploadId: "up_a" }, { name: "Iver", uploadId: "up_b" }]);
  // A gap in the run: the text is not what the compiler wrote.
  expect(citedStills("@Image1 is Cass: a. @Image3 is Iver: b.", refs("up_a", "mine", "up_b"))).toEqual([]);
  // Not ending at the last image: something was renumbered or dropped.
  expect(citedStills("@Image1 is Cass: a courier.", refs("up_a", "up_b"))).toEqual([]);
  // Descending, which the compiler never writes.
  expect(citedStills("@Image2 is Cass: a. @Image1 is Iver: b.", refs("up_a", "up_b"))).toEqual([]);
  // A repeated name still resolves once, and the run is judged on what is left.
  expect(citedStills("@Image1 is Cass: a. @Image1 is Cass: a.", refs("up_a")))
    .toEqual([{ name: "Cass", uploadId: "up_a" }]);
});

test("version history comes out oldest first, with today's still last", () => {
  const takes = [
    { compiled: "@Image1 is Cass: x.", refs: refs("coat"), createdAt: 100 },
    { compiled: "@Image1 is Cass: x.", refs: refs("coat"), createdAt: 200 },
    { compiled: "@Image1 is Cass: x.", refs: refs("overalls"), createdAt: 300 },
    { compiled: "@Image1 is Iver: y.", refs: refs("someone-else"), createdAt: 400 },
  ];
  expect(versionsFromTakes("Cass", takes, "overalls")).toEqual(["coat", "overalls"]);

  // A still nothing has been rendered with yet is still the current version.
  expect(versionsFromTakes("Cass", takes, "new-coat")).toEqual(["coat", "overalls", "new-coat"]);

  // A name that was never cited and has no still has no history to invent.
  expect(versionsFromTakes("Nobody", takes, null)).toEqual([]);

  // Case-blind, the way the citation itself is resolved.
  expect(versionsFromTakes("cass", takes, null)).toEqual(["coat", "overalls"]);
});

test("versions read as numbers, with the team's word beside them", () => {
  expect(versionNumber(0)).toBe("v1");
  expect(versionLine(1, "waxed coat")).toBe("v2 waxed coat");
  expect(versionLine(1, "  ")).toBe("v2");
});
