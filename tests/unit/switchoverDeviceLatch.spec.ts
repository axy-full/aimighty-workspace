import { test, expect } from "@playwright/test";
import { createDeviceLatch, type MediaProbe } from "../../lib/workspace/device";
import { PHONE_QUERY } from "../../lib/workspace/switchover";

/**
 * The gate's device answer is latched to one document.
 *
 * The media query is driven directly here — a probe whose `matches` flips
 * under the latch, the way a landscape phone's does when a keyboard closes or
 * browser chrome collapses — so the guarantee is tested without a viewport, a
 * resize or a race.
 */

/** A MediaQueryList's one relevant field, plus a way to change it mid-document. */
function probe(matches: boolean) {
  const live: MediaProbe & { reads: number } = {
    get matches() {
      live.reads += 1;
      return matches;
    },
    reads: 0,
  };
  return { live, set: (next: boolean) => (matches = next) };
}

test("a phone stays a phone when the viewport changes under it", () => {
  const { live, set } = probe(true);
  const latch = createDeviceLatch(() => live);

  expect(latch.snapshot()).toBe("phone");
  /* The keyboard closes: the landscape phone is now 844×700, so PHONE_QUERY no
     longer matches. The answer does not move, so the gate never redirects. */
  set(false);
  expect(latch.snapshot()).toBe("phone");
  expect(latch.snapshot()).toBe("phone");
});

test("a desktop stays a desktop when the window is made phone-sized", () => {
  const { live, set } = probe(false);
  const latch = createDeviceLatch(() => live);

  expect(latch.snapshot()).toBe("desktop");
  set(true);
  expect(latch.snapshot()).toBe("desktop");
});

test("the query is read once, and subscribing delivers nothing to re-read it", () => {
  const { live } = probe(true);
  const latch = createDeviceLatch(() => live);
  let updates = 0;

  const stop = latch.subscribe(() => (updates += 1));
  latch.snapshot();
  latch.snapshot();
  latch.snapshot();
  stop();

  expect(live.reads).toBe(1);
  expect(updates).toBe(0);
});

test("the server has no answer, and a new document decides freshly", () => {
  const { live } = probe(true);
  expect(createDeviceLatch(() => live).serverSnapshot()).toBe("pending");

  /* A rotation that reloads the document is a new latch, so it re-decides:
     latching is per document, not per device. */
  const rotated = probe(false);
  expect(createDeviceLatch(() => rotated.live).snapshot()).toBe("desktop");
});

test("the probe is not called until the answer is wanted, so the latch can live at module scope", () => {
  let called = 0;
  const latch = createDeviceLatch(() => {
    called += 1;
    return { matches: true };
  });
  expect(called).toBe(0);
  latch.snapshot();
  expect(called).toBe(1);
});

test("the landscape-phone clause is the one that moves, and it is still in the query", () => {
  /* The defect this latch fixes lives in the second clause: a height, on a
     touch phone, which changes without anybody rotating the device. */
  expect(PHONE_QUERY).toContain("(hover: none) and (pointer: coarse) and (max-height: 500px)");
});
