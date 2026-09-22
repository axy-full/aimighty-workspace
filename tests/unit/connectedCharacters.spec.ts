import { test, expect } from "@playwright/test";
import { parseCharacters } from "../../lib/higgsfield-consumer/characters";

/** FINAL_SPEC §4 › Soul ID: the account's trained characters, bounded and text-only, wherever the reply nests them. */
test("characters are read by soul_id or id, typed and statused only from the known words, and never from junk", () => {
  const reply = { characters: [
    { soul_id: "soul_9f2a", name: "Mira / character study", type: "soul_2", status: "ready", preview_url: "https://cdn.example/mira.jpg" },
    { id: "abc-123", name: "", type: "soul_cinematic", status: "training", preview_url: "http://insecure.example/x.jpg" },
    { soul_id: "bad id with spaces", name: "Nope" },
    { soul_id: "x".repeat(300), name: "Too long" },
    "not a record",
    { soul_id: "soul_odd", name: "Odd", type: "lora", status: "queued" },
  ] };
  expect(parseCharacters(reply)).toEqual([
    { soulId: "soul_9f2a", name: "Mira / character study", type: "soul_2", status: "ready", previewUrl: "https://cdn.example/mira.jpg" },
    { soulId: "abc-123", name: "abc-123", type: "soul_cinematic", status: "training", previewUrl: null },
    { soulId: "soul_odd", name: "Odd", type: null, status: null, previewUrl: null },
  ]);
  expect(parseCharacters({ results: [{ soul_id: "s1", name: "One" }] })).toHaveLength(1);
  expect(parseCharacters([{ soul_id: "s2", name: "Two" }])).toHaveLength(1);
  expect(parseCharacters({ nothing: true })).toEqual([]);
  expect(parseCharacters(null)).toEqual([]);
  expect(parseCharacters({ items: Array.from({ length: 150 }, (_, i) => ({ soul_id: `s${i}`, name: `n${i}` })) })).toHaveLength(100);
});
