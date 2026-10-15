import Image from "next/image";
import { Tooltip } from "../ui";

/** The brand's own horizontal lockup, on dark (public/brand; the new interface is dark). Nothing else may draw the header's logo: tests/unit/brandAssets-guard.spec.ts. */
export const HEADER_LOGO = "/brand/particl-lockup-horizontal-on-dark@4x.png";

/**
 * The top bar's logo: the brand's horizontal lockup (mark, wordmark and its "studio" line), the real asset from public/brand, never a drawing of it. The v25
 * prototype's ring with a dot and plain "particl" text is a placeholder, not the brand (owner, 15 Oct); the lockup is used rather than the mark alone because the v25 bar
 * shows a wordmark. One piece for the signed-in header and the visitor's; `shortcut` is what the tooltip advertises, and a header that binds no key for Home leaves it out
 * (the visitor's). The button's accessible name is "particl, Home"; the picture is decorative.
 */
export function HeaderLogo({ onClick, testId, shortcut }: { onClick: () => void; testId: string; shortcut?: string | readonly string[] }) {
  return (
    <Tooltip name="Home" shortcut={shortcut}>
      <button type="button" className="v12-logo" onClick={onClick} aria-label="particl, Home" data-testid={testId}>
        <Image src={HEADER_LOGO} alt="" width={102} height={40} priority className="v12-logo-img" />
      </button>
    </Tooltip>
  );
}
