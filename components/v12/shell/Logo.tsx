import { Tooltip } from "../ui";
import { BrandLogo } from "@/components/ui/BrandLogo";

/**
 * The top bar's logo: the brand's mark and wordmark (components/ui/BrandLogo.tsx, from public/brand), never the v25 prototype's placeholder, a ring with a dot and plain
 * "particl" text (owner, 15 Oct). One piece for the signed-in header and the visitor's; `shortcut` is what the tooltip advertises, and a header that binds no key for Home
 * leaves it out (the visitor's). Its accessible name is "particl, Home"; the pictures are decorative.
 */
export function HeaderLogo({ onClick, testId, shortcut }: { onClick: () => void; testId: string; shortcut?: string | readonly string[] }) {
  return (
    <Tooltip name="Home" shortcut={shortcut}>
      <button type="button" className="v12-logo" onClick={onClick} aria-label="particl, Home" data-testid={testId}>
        <BrandLogo />
      </button>
    </Tooltip>
  );
}
