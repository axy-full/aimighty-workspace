import "./brand-logo.css";

/**
 * The brand's logo at a header's size, from the brand's own files in public/brand (owner, 15 Oct: "the header uses the mark + wordmark (no "STUDIO" line) at small
 * sizes; the full lockup only where it renders large (sign-in, marketing, documents)"): the mark, then the wordmark. The app is dark, so the on-dark files; there is no
 * light theme. A drawing of the mark with the name typed beside it is not the brand. tests/unit/brandAssets-guard.spec.ts holds all of this.
 *
 * Both files carry air a header has no use for, and the wordmark file carries its "studio" line under the word. They are shown cropped to what the bar needs (the trail
 * of dots; the word) by boxes that clip the pictures, so the files themselves are not altered. `wordmark={false}` is the mark alone (a phone's header).
 */
export const BRAND_MARK = "/brand/particl-mark-on-dark.svg";
export const BRAND_WORDMARK = "/brand/particl-wordmark-on-dark@4x.png";

/**
 * The wordmark file is a 1188 px picture (38 KB); a header shows it 68 px wide. It is asked of Next's own image route at the sizes it needs (1x, 2x, 3x, the sizes
 * next/image would ask for), as a plain <img>: next/image itself would put its client component (about 12 KB of script) into every screen's first load for one logo.
 */
const sized = (file: string, width: number) => `/_next/image?url=${encodeURIComponent(file)}&w=${width}&q=75`;

export function BrandLogo() {
  return (
    <span className="brand-logo" aria-hidden="true">
      {/* eslint-disable @next/next/no-img-element -- see `sized` */}
      <span className="brand-logo-mark"><img src={BRAND_MARK} alt="" width={200} height={200} fetchPriority="high" /></span>
      <span className="brand-logo-word"><img src={sized(BRAND_WORDMARK, 128)} srcSet={`${sized(BRAND_WORDMARK, 128)} 1x, ${sized(BRAND_WORDMARK, 256)} 2x, ${sized(BRAND_WORDMARK, 384)} 3x`} alt="" width={1188} height={640} fetchPriority="high" /></span>
      {/* eslint-enable @next/next/no-img-element */}
    </span>
  );
}
