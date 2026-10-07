import { test, expect } from "@playwright/test";
import { fixLine, quotePrice, fixBody } from "../../components/graphite/phone/use-fix";
import { editQuoteBody } from "../../components/graphite/board/inspector/inspector-model";
import { priceLabel } from "../../lib/spend";

test("the fix counts against the two the plan allows: the next fix is the number of versions the shot has", () => {
  expect(fixLine(1)).toBe("fix 1 of 2");
  expect(fixLine(2)).toBe("fix 2 of 2");
  /* Past the allowance the line does not pretend there is a second figure to count against. */
  expect(fixLine(3)).toBe("fix 3");
  expect(fixLine(0)).toBe("fix 1 of 2");
});

test("the price on Make the fix is the server's quote: exact, or up to when it settles on what was delivered; none is none", () => {
  const quote = { fingerprint: "a".repeat(64), estimatedCredits: 43, price: 43, unit: "cr" as const };
  expect(priceLabel(quotePrice(quote))).toBe("43 cr");
  expect(priceLabel(quotePrice({ ...quote, approximate: true }))).toBe("up to 43 cr");
  expect(quotePrice({ ...quote, unit: "usd" })).toBeNull();
  expect(quotePrice(null)).toBeNull();
});

test("the quote and the send are the Seedance Edit request, with the person's own words; empty words stand in with one", () => {
  const entry = { asset: { origin: "generation", value: { id: "gen_1" } }, media: "video" } as never;
  const body = fixBody(entry, "prj_1", "Plant her feet");
  expect(body).toMatchObject({ projectId: "prj_1", task: "edit", model: "dreamina-seedance-2-5-260628", sourceGenId: "gen_1", rawPrompt: "Plant her feet", prompt: "Edit @Video1: Plant her feet", resolution: "720p" });
  expect(fixBody(entry, "prj_1", "  ")).toMatchObject({ rawPrompt: "change" });
  /* The Inspector's own price asks the same question it always did. */
  expect(editQuoteBody({ genId: "gen_1", media: "video", entry } as never, "prj_1")).toMatchObject({ rawPrompt: "change", prompt: "Edit @Video1: change" });
  /* A still is not an edit: no body, no quote. */
  expect(fixBody({ asset: { origin: "generation", value: { id: "gen_2" } }, media: "image" } as never, "prj_1", "x")).toBeNull();
  expect(fixBody({ asset: { origin: "upload", value: { id: "u" } }, media: "video" } as never, "prj_1", "x")).toBeNull();
});
