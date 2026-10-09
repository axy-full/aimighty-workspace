import { test, expect } from "@playwright/test";
import { HOW_HINTS, HOW_TOPICS, howAnswer, howFacts } from "../../lib/shell/atomik-how";

/*
 * "Ask Atomik how" (README § 3.4, Atomik frames p): answered free from a table, no model call, each answer with an
 * offer that is the screen's own action, and no figure that is not the server's (lead decision 29).
 */

test("the design's own questions are answered, with the offer the design draws", () => {
  const reference = howAnswer(HOW_HINTS[0]);
  expect(reference.text).toBe("Drag anything from the Library onto the shot, or press + in Make’s references tray. I can open the Library for you.");
  expect(reference.offer).toEqual({ label: "Open the Library", action: { kind: "library" } });
  const hero = howAnswer(HOW_HINTS[1]);
  expect(hero.topic).toBe("hero-cost");
  expect(hero.offer?.action).toEqual({ kind: "make" });
});

test("a price in an answer is the rate card's, and without it no figure is said", () => {
  expect(howAnswer("What does a hero take cost?").text).not.toMatch(/\d+ cr/);
  const rates = [{ kind: "video", axis: "resolution", seconds: 5, rows: [{ engine: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", audio: false, cells: [{ option: "720p", credits: 18 }, { option: "1080p", credits: 43 }] }] }];
  const facts = howFacts(rates);
  expect(facts.heroTake).toEqual({ kind: "exact", credits: 43 });
  expect(howAnswer("What does a hero take cost?", facts).text).toContain("43 cr on the rate card");
  expect(howFacts(null)).toEqual({});
  expect(howFacts([{ kind: "video", rows: [] }]).heroTake).toBeNull();
});

test("every topic answers in plain words, with no bare \"quoted\" and no vendor dollars", () => {
  const questions = [
    "how do I recast a video with motion transfer?", "how do I keep the same face?", "how do I compare takes?", "can I undo?",
    "how does memory work?", "what is a skill?", "how do I connect Claude over MCP?", "how do I top up?", "how do I invite my team?",
    "who can approve?", "what is waiting for approval?", "how do I search?", "where is the library?", "how do I make a still?",
    "how much did this cost?", "how do I start a new film?", "what is the meaning of life?", "What does a hero take cost?", "How do I add a reference to a shot?",
  ];
  const seen = new Set<string>();
  for (const q of questions) {
    const a = howAnswer(q);
    seen.add(a.topic);
    expect(a.text.length, q).toBeGreaterThan(20);
    expect(a.text, q).not.toMatch(/quoted|\$\d/);
  }
  for (const id of HOW_TOPICS) expect(seen, `topic ${id} answered by one of the sample questions`).toContain(id);
});

test("an offer for what only a person may do opens the place, it never presses anything", () => {
  for (const q of ["how do I top up?", "who can approve?", "what is waiting for approval?", "how do I keep the same face?"]) {
    const action = howAnswer(q).offer?.action;
    expect(["settings", "control", "region"], q).toContain(action?.kind);
  }
});
