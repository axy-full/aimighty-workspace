"use client";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { useSettingsData } from "@/lib/workspace/use-settings";

/**
 * Settings (05-mobile "Settings (M10)", the repo's board M10): the credits
 * card, the workspace rows, the team rows with their roles and Invite, then
 * Atomik's three rules.
 *
 * Everything here reads a route the product already has (see
 * lib/workspace/settings-data.ts). Two things the design draws are NOT here,
 * because nothing in the product can supply them and inventing them would be
 * worse than leaving them out:
 *
 *  - the auto top-up switch: no schema, setting or route holds an auto top-up
 *    anywhere, so there is nothing for a switch to read or write;
 *  - a plan name: it lives behind the billing route's subscription, which this
 *    screen does not read.
 *
 * Top up and Invite link into the flows that own them — the billing page's
 * credit packs and the team page — rather than a second implementation of
 * either on a phone.
 */
export function SettingsScreen({ account }: { account: WorkspaceAccount | null }) {
  const data = useSettingsData();
  /* The header's balance is already live; this screen shows it again with its
     dollar value, and falls back to the header's figure while /api/me lands. */
  const balance = data.credits?.balance ?? (account?.credits ? `${account.credits.balance.toLocaleString("en-US")} CR` : null);

  return (
    <div className="pxm-pad" data-screen="settings">
      <div className="pxm-card" data-testid="mobile-settings-credits">
        <div className="pxm-kicker" data-functional-label="">CREDITS</div>
        <div className="pxm-balance-row">
          <span className="pxm-balance" data-testid="mobile-settings-balance">{balance ?? "—"}</span>
          {data.credits?.usd ? <span className="pxm-balance-usd" data-testid="mobile-settings-usd">{data.credits.usd}</span> : null}
        </div>
        {data.credits?.month ? <div className="pxm-settings-month" data-testid="mobile-settings-month">{data.credits.month}</div> : null}
        {/* What a credit is, once, on the screen the top-up button lives on. */}
        {data.credits?.rate ? <div className="pxm-settings-month" data-testid="mobile-settings-rate">{data.credits.rate}</div> : null}
        {data.topup ? (
          <a className="pxm-primary pxm-primary-wide" href={data.topup.href} data-testid="mobile-settings-topup">
            <span className="pxm-primary-label">{data.topup.label}</span>
          </a>
        ) : null}
      </div>

      {data.rows.length ? (
        <>
          <div className="pxm-kicker pxm-settings-kicker" data-functional-label="">WORKSPACE</div>
          <div className="pxm-settings-group" data-testid="mobile-settings-workspace">
            {data.rows.map((row) =>
              row.href ? (
                <a className="pxm-settings-row" key={row.label} href={row.href} data-row={row.label}>
                  <SettingsRowText label={row.label} value={row.value} />
                  <span className="pxm-settings-action">{row.action ? `${row.action} ›` : "›"}</span>
                </a>
              ) : (
                <div className="pxm-settings-row" key={row.label} data-row={row.label}>
                  <SettingsRowText label={row.label} value={row.value} />
                  {row.action ? <span className="pxm-settings-action">{row.action}</span> : null}
                </div>
              ),
            )}
          </div>
        </>
      ) : null}

      {data.team?.length ? (
        <>
          <div className="pxm-kicker pxm-settings-kicker" data-functional-label="">TEAM</div>
          <div className="pxm-settings-group" data-testid="mobile-settings-team">
            {data.team.map((member) => (
              <div className="pxm-team-row" key={member.id} data-member={member.id}>
                <span className="pxm-team-avatar" aria-hidden="true">{member.initials}</span>
                <span className="pxm-grow pxm-team-name">{member.name}</span>
                {member.role ? <span className="pxm-team-role">{member.role}</span> : null}
              </div>
            ))}
            {data.inviteHref ? (
              <a className="pxm-invite" href={data.inviteHref} data-testid="mobile-settings-invite">+ Invite</a>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="pxm-kicker pxm-settings-kicker" data-functional-label="">ATOMIK RULES</div>
      <div className="pxm-settings-group" data-testid="mobile-settings-rules">
        {data.rules.map((rule) => (
          <div className="pxm-rule" key={rule.label} data-rule={rule.label}>
            <div className="pxm-rule-label" data-functional-label="">{rule.label}</div>
            <div className="pxm-rule-sub">{rule.sub}</div>
          </div>
        ))}
      </div>

      {data.unavailable ? <p className="pxm-note" data-testid="mobile-settings-unavailable">{data.unavailable}</p> : null}
    </div>
  );
}

function SettingsRowText({ label, value }: { label: string; value: string }) {
  return (
    <span className="pxm-grow">
      <span className="pxm-settings-label">{label}</span>
      <span className="pxm-settings-value">{value}</span>
    </span>
  );
}
