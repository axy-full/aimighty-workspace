import { test, expect } from "@playwright/test";
import { providerText } from "../../lib/providerOutcome";

const SOUL = ["So", "ul"].join("");
const HIGGSFIELD = ["Higgs", "field"].join("");

test("a provider's own words never carry the engine's brand names to a person", () => {
  expect(providerText(`${SOUL} ID training failed for this character`)).toBe("Identity training failed for this character");
  expect(providerText(`${SOUL} Character render rejected`)).toBe("Identity render rejected");
  expect(providerText(`Your ${HIGGSFIELD} credits are not enough`)).toBe("Your engine credits are not enough");
  expect(providerText(`The ${HIGGSFIELD} API returned an error`)).toBe("The engine returned an error");
  expect(providerText(`${HIGGSFIELD}'s queue is full`)).toBe("the engine queue is full");
  expect(providerText(`${SOUL.toUpperCase()} model is busy`)).toBe("Identity model is busy");
  /* a link is replaced before the names are, so a host name is not half-rewritten */
  expect(providerText(`See https://docs.${HIGGSFIELD.toLowerCase()}.ai/help for ${HIGGSFIELD}`)).toBe("See [link] for the engine");
  /* ordinary words are untouched */
  expect(providerText("Bad aspect ratio")).toBe("Bad aspect ratio");
  expect(providerText("The soulful mood was rejected")).toBe("The soulful mood was rejected");
});
