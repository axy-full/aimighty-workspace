/**
 * The ⋯ icon of every "more" button (the board header's menu, a stage's menu on the rail): three equal dots drawn as a picture, symmetric about
 * the middle of its own box, so a button that centres its content centres the dots. The ⋯ character did not: its font gives it uneven side bearings,
 * and the dots sat well left of centre. Takes its colour from the button (`currentColor`).
 */
export function MoreDots({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}
