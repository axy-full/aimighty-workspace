import Image from "next/image";
import { Tooltip } from "../ui";

/**
 * The top bar's logo, from the brand's own files in public/brand (owner, 15 Oct: "the header uses the mark + wordmark (no "STUDIO" line) at small sizes; the full lockup only
 * where it renders large (sign-in, marketing, documents)"): the mark, then the wordmark. The new interface is dark, so the on-dark files; there is no light theme.
 * The v25 prototype's ring with a dot and plain "particl" text is a placeholder, not the brand. tests/unit/brandAssets-guard.spec.ts holds all of this.
 *
 * Both files carry air the bar has no use for, and the wordmark file carries its "studio" line under the word. They are shown cropped to what the bar needs
 * (the trail of dots; the word), by a box that clips the picture, so the files themselves are not altered.
 */
export const HEADER_MARK = "/brand/particl-mark-on-dark.svg";
export const HEADER_WORDMARK = "/brand/particl-wordmark-on-dark@4x.png";

/** One logo for the signed-in header and the visitor's; `shortcut` is what the tooltip advertises, and a header that binds no key for Home leaves it out (the visitor's). Its accessible name is "particl, Home"; the pictures are decorative. */
export function HeaderLogo({ onClick, testId, shortcut }: { onClick: () => void; testId: string; shortcut?: string | readonly string[] }) {
  return (
    <Tooltip name="Home" shortcut={shortcut}>
      <button type="button" className="v12-logo" onClick={onClick} aria-label="particl, Home" data-testid={testId}>
        <span className="v12-logo-mark"><Image src={HEADER_MARK} alt="" width={200} height={200} unoptimized priority /></span>
        <span className="v12-logo-word"><Image src={HEADER_WORDMARK} alt="" width={1188} height={640} priority /></span>
      </button>
    </Tooltip>
  );
}
