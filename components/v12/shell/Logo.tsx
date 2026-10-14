import { Tooltip } from "../ui";

/**
 * The top bar's logo, as the v25 prototype draws it (design/particl-prototype-25, "Particl board.dc.html" header): a ring with the accent dot in it, and
 * the wordmark. One piece for the signed-in header and the visitor's; `shortcut` is what the tooltip advertises, and a header that binds no key for Home leaves it out (the visitor's).
 */
export function HeaderLogo({ onClick, testId, shortcut }: { onClick: () => void; testId: string; shortcut?: string | readonly string[] }) {
  return (
    <Tooltip name="Home" shortcut={shortcut}>
      <button type="button" className="v12-logo" onClick={onClick} aria-label="particl, Home" data-testid={testId}>
        <span className="v12-logo-ring" aria-hidden="true"><span className="v12-logo-dot" /></span>
        <span className="v12-logo-name">particl</span>
      </button>
    </Tooltip>
  );
}
