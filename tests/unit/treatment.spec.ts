import { test, expect } from "@playwright/test";
import { sceneFromReply } from "../../lib/atomikDocs";

/** A regenerated scene comes back as JSON the model may wrap in a fence or prose; it is read out and clamped, or refused (brief 1.8). */
test("a scene reply is read out of a fence or prose, clamped, and refused without prose", () => {
  expect(sceneFromReply('```json\n{"title":"The jetty","secs":7,"prose":"Mara ties off the boat."}\n```')).toEqual({ title: "The jetty", secs: 7, prose: "Mara ties off the boat." });
  expect(sceneFromReply('Here you go: {"title":"","secs":"900","prose":"  A long take.  "} thanks')).toEqual({ title: "", secs: 600, prose: "A long take." });
  expect(sceneFromReply('{"title":"x","secs":5,"prose":""}')).toBeNull();
  expect(sceneFromReply("no json here")).toBeNull();
  expect(sceneFromReply('{"prose":"ok","secs":-3}')?.secs).toBe(0);
});
