/**
 * What a model will actually accept, counted after everything is attached.
 *
 * References used to be checked once, at the moment they arrived from the
 * browser — which is before the cast block runs. `expandCast` pushes a still
 * for every cited name, so attaching two images to a two-image model and then
 * writing "@Mara rides @Mule" passed the check with two and left with four,
 * and nothing anywhere said so.
 *
 * What happens next is not a refusal but a silent change of meaning. On fal,
 * `images[0]` becomes the FIRST FRAME and the next becomes the LAST FRAME
 * (lib/falVideo.ts:132-134); everything beyond two is discarded. So a
 * reference somebody attached can quietly turn into a frame, and a
 * text-to-video into an image-to-video, priced and recorded as neither.
 * Kling v3 caps at two. Some models take none at all.
 *
 * The still path already counted the cast against the ceiling and said so in
 * its own comment. This is the same rule, made testable and given to the
 * video path as well.
 */

export type CountedRef = { role: string };

export type Ceiling = { maxReferenceImages: number; label: string };

/**
 * The problem with this set of references, or null.
 *
 * Only the IMAGE rules: the cast attaches `reference_image` rows and nothing
 * else, so a video count and a total-seconds budget are settled before this
 * and the durations needed to re-test them are not carried this far.
 */
export function ceilingProblem(
  refs: readonly CountedRef[],
  model: Ceiling,
  citedCast: readonly string[] = [],
): string | null {
  const frames = refs.filter((r) => r.role === "first_frame" || r.role === "last_frame").length;
  const images = refs.filter((r) => r.role === "reference_image").length;

  /* Naming the cast is the difference between a message someone can act on
     and one that accuses them of attaching files they did not attach. */
  const alsoCast = citedCast.length
    ? ` Cited cast (${citedCast.map((n) => `@${n}`).join(", ")}) attach their stills too.`
    : "";

  if (frames > 0 && images > 0) {
    return `First/last frame and reference media can't be mixed — ModelArk treats them as separate modes.${alsoCast}`;
  }
  if (images > model.maxReferenceImages) {
    return `${model.label} accepts at most ${model.maxReferenceImages} reference images (${images} attached).${alsoCast}`;
  }
  return null;
}
