import { test, expect } from "@playwright/test";
import { MONEY_REFUSAL, amountRefusal, findAmount, mentionsMoney, parseImport, rankForPlanner, readProposals } from "../../lib/atomikMemoryText";

/**
 * Memory's money rule, as the owner set it on 29 Sep: refuse only actual
 * amounts — a price, a cost, a credit amount, a currency amount, a markup or
 * a margin given as a number — because a figure goes out of date and a
 * vendor's cost must never reach a client. Every word about money is welcome:
 * a customer uses "premium price point" or "cost-effective" to explain their
 * product. The refusal says amounts can't be remembered, and names the one it
 * found.
 */

/** Each line, and the amount the check finds in it, as written. */
const AMOUNTS: [string, string][] = [
  /* A currency sign with a number, on either side. */
  ["Our Studio plan is $49 a month.", "$49"],
  ["Shot for US$49 a day.", "$49"],
  ["€1,200 per shoot", "€1,200"],
  ["Prints at £5.99 each.", "£5.99"],
  ["¥300 a frame", "¥300"],
  ["₹999 only", "₹999"],
  ["$2.5m raise", "$2.5m"],
  ["$1.2 million in ad spend", "$1.2 million"],
  ["49€", "49€"],
  ["49 € each", "49 €"],
  ["99¢ a still", "99¢"],
  ["$20–$40 a pack", "$20"],
  /* A currency code or word with a number. */
  ["Costs USD 49.", "USD 49"],
  ["49 USD", "49 USD"],
  ["Rs. 499", "Rs. 499"],
  ["INR 5,000 a month", "INR 5,000"],
  ["2.5k USD", "2.5k USD"],
  ["5k euros for the shoot", "5k euros"],
  ["fifty dollars", "fifty dollars"],
  ["a hundred bucks", "hundred bucks"],
  ["twenty-five dollars", "twenty-five dollars"],
  ["under fifty dollars", "fifty dollars"],
  ["a million dollars", "million dollars"],
  ["A 5-dollar coffee.", "5-dollar"],
  ["5 grand for the shoot.", "5 grand"],
  ["99 cents a still.", "99 cents"],
  /* A number of credits. */
  ["25 credits per take", "25 credits"],
  ["25 cr", "25 cr"],
  ["25cr", "25cr"],
  ["1 credit", "1 credit"],
  ["1.5k credits", "1.5k credits"],
  ["Pro tier: 1,200 cr a month.", "1,200 cr"],
  ["credits: 400", "credits: 400"],
  ["credit balance: 400", "credit balance: 400"],
  ["We have 400 credits left in the wallet.", "400 credits"],
  ["Rate card: 25 cr for a hero take.", "25 cr"],
  /* A price or a cost as a number, with no sign at all. */
  ["The kit costs 49 a month.", "costs 49"],
  ["Priced at 120.", "Priced at 120"],
  ["Sells for 35.", "Sells for 35"],
  ["Retails at 80.", "Retails at 80"],
  ["MSRP 129.", "MSRP 129"],
  ["Price: 49", "Price: 49"],
  ["Our price point is 49.", "price point is 49"],
  ["Budget of 5000.", "Budget of 5000"],
  ["Budget: 4K.", "Budget: 4K"],
  ["Fee: 20", "Fee: 20"],
  ["Account balance of 1,200", "balance of 1,200"],
  ["Day rate: 500", "Day rate: 500"],
  /* A markup or a margin as a number. */
  ["A 30% markup.", "30% markup"],
  ["Markup of 40%.", "Markup of 40%"],
  ["Marked up 30%.", "Marked up 30%"],
  ["A 2x markup.", "2x markup"],
  ["Cost plus 20%.", "Cost plus 20%"],
  ["20% above cost.", "20% above cost"],
  ["30% on top of the vendor price.", "30% on top of the vendor price"],
  ["15% commission.", "15% commission"],
  ["40% gross margin.", "40% gross margin"],
  ["A margin of 35% on every pack.", "margin of 35%"],
  ["We take a 30% margin.", "30% margin"],
  ["Our margin is 40%.", "margin is 40%"],
  /* A layout margin in one sentence does not hide a money margin in the next. */
  ["Keep a 10% margin around the logo. We take a 30% margin on sales.", "30% margin"],
  /* A card's number is never kept either (it passes the Luhn check; an id or a barcode seldom does). */
  ["Card 4242 4242 4242 4242", "4242 4242 4242 4242"],
];

/** Words about money, film words, and numbers that are not money: all of them are kept. */
const WORDS = [
  /* The owner's examples, and their kin. */
  "Premium price point.", "Our price point is premium.", "Pricing is premium, never discount-led.", "Budget-friendly, affordable and cost-effective.",
  "Our fee is premium.", "Price: on request.", "A healthy markup.", "Our margins are healthy.", "Our margin is healthy at every tier.",
  "Our plan is Agency until March.", "Top-ups go on the company card.", "A million-dollar look on an indie budget.", "A dollar-store aesthetic.",
  "Our two cents: keep it short.",
  /* A film studio's own words. */
  "A low-budget handheld look.", "Opening credits in Futura, white on black.", "Credits roll at 2:30.", "Opening credits: 30 seconds.",
  "Maya has three feature credits.", "Season 2 credits roll over the skyline.", "We run 2 credits sequences per film.", "White balance at 5600K.",
  "Keep a wide margin around the logo.", "Keep a 10% margin around the logo.", "40% margin of white space on each side.", "Margin: 12px.",
  "Frame rate: 24 fps.", "1080p, 24fps, 16:9 and 9:16.", "Lens 85mm at f/1.8.", "1.5x speed ramps.", "A 3x zoom on the product.", "Plan the shots around the golden hour.",
  /* Numbers that are not money. */
  "Our 2025 launch.", "Shot in 4K.", "Spots run 30 s.", "Budget 2025 campaign.", "Shot in Q4 2025 for the budget launch.", "The price in 2026 stays premium.",
  "It costs 2 days of prep.", "Our budget is 3 shoot days.", "We spent 3 days on set.", "Prices from 3 suppliers.", "Our ad budget is 30% of revenue.",
  "Skaters, 16 to 24.", "Ages 25-34.", "Teal #0FA3A3 and warm sand.", "Version 2.5 of the logo.", "100% organic cotton.", "30% of our audience is in Lagos.",
  "Dumbbells weigh 5 pounds.", "Built on PHP 8.", "Phone +1 415 555 0100.", "Order #12345 shipped.", "A 2x4 plank as a prop.", "2 grand prix wins.",
  /* A sign alone, and discounts: not amounts of a price or a cost. */
  "The $ sign in our logo.", "The $$$ tier.", "50% off for students.", "Save 20% at checkout.",
];

test("a price, a cost, credits, a currency, a markup or a margin given as a number is an amount, named as written", () => {
  for (const [line, found] of AMOUNTS) {
    expect(findAmount(line), line).toBe(found);
    expect(mentionsMoney(line), line).toBe(true);
  }
});

test("words about money, a film's own words and numbers that are not money are kept", () => {
  for (const line of WORDS) expect(findAmount(line), line).toBeNull();
});

test("the tricky ones: a year, a resolution, a length, a sign alone and a discount are not amounts", () => {
  for (const line of ["2025 launch", "4K", "30 s", "$", "50% off"]) expect(mentionsMoney(line), line).toBe(false);
  /* Give each a figure of money and it is one. */
  expect(findAmount("2025 launch at $49")).toBe("$49");
  expect(findAmount("4K masters for 300 credits")).toBe("300 credits");
  expect(findAmount("30 s spots priced at 900")).toBe("priced at 900");
  expect(findAmount("$ 5")).toBe("$ 5");
  expect(findAmount("50% off a 30% markup")).toBe("30% markup");
});

test("the refusal says amounts can't be remembered, and names the amount to take out", () => {
  expect(MONEY_REFUSAL).toMatch(/^Amounts can't be remembered: prices, costs, credits and markups go out of date\./);
  expect(MONEY_REFUSAL).toContain("Words such as “premium price point” are fine.");
  expect(amountRefusal("Our Studio plan is $49 a month.")).toBe("Amounts can't be remembered: prices, costs, credits and markups go out of date. Take out “$49” and save it again. Words such as “premium price point” are fine.");
  expect(amountRefusal("Premium price point.")).toBe(MONEY_REFUSAL);
  /* A long amount is cut in the sentence, never the check. */
  expect(amountRefusal(`Costs ${"9".repeat(60)} dollars`)).toContain(`Take out “${"9".repeat(39)}…”`);
});

test("an amount is left out wherever it comes from: a paste, Atomik's proposals, a planner's share", () => {
  const paste = parseImport(["- Premium price point, never discount-led", "- Packs are $49", "- Our margin is 40%", "- Budget-friendly for students"].join("\n"));
  expect(paste.entries.map((e) => e.text)).toEqual(["Premium price point, never discount-led", "Budget-friendly for students"]);
  expect(paste.skipped.money).toBe(2);
  const read = readProposals(JSON.stringify({ entries: [{ kind: "brand", text: "A premium price point" }, { kind: "note", text: "Packs cost 49 credits" }, { kind: "brand", text: "Cost-effective for teams" }] }))!;
  expect(read.entries.map((e) => e.text)).toEqual(["A premium price point", "Cost-effective for teams"]);
  expect(read.skipped.money).toBe(1);
  const share = rankForPlanner([
    { id: "a", kind: "brand", text: "A premium price point", updatedAt: 2, projectId: null },
    { id: "b", kind: "brand", text: "Packs are $49", updatedAt: 1, projectId: null },
  ], { projectId: null, query: "price" });
  expect(share.map((i) => i.text)).toEqual(["A premium price point"]);
});
