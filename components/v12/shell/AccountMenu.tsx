"use client";
import { useEffect, useRef, useState } from "react";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { avatarInitials } from "@/lib/shell/person";
import { creditsLabel } from "@/lib/workspace/format";
import { signOut } from "@/lib/shell/sign-out";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { switchWorkspace, useSwitchState } from "@/lib/shell/switch-workspace";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import type { Topups } from "@/lib/shell/workspace-view";
import { useMoney } from "@/lib/price";
import { spentUsdOf } from "@/lib/v12/billing";
import { topUpPack } from "@/components/graphite/settings/model";
import { useRead } from "@/components/graphite/settings/use-settings";
import { useGoSettings } from "@/components/graphite/settings/navigate";
import { Menu, Tooltip, useToast, type MenuItem } from "../ui";

/**
 * The avatar and its menu (docs/redesign/inventory.md § 5.5; prototype L54): the balance with Top up, Credits &
 * billing, Settings, then Sign out. The balance lives here, not in a header pill. Top up opens today's Plan & credits
 * flow unchanged, and is drawn only where that flow can take a request (an owner or admin of a workspace on credits): a
 * member is told who can, and the house workspace, which pays in dollars at the engines' cost, has none and says so.
 * Never a button that goes nowhere. Both answers are today's reads (GET /api/workspaces/topups, GET /api/usage/summary),
 * read when the menu opens. Sign out and switching workspace are today's (components/graphite/SettingsMenu.tsx).
 */
export function AccountMenu({ account }: { account: WorkspaceAccount | null }) {
  const shell = useShell();
  const session = useSession();
  const scopedFetch = useScopedFetch();
  const goSettings = useGoSettings();
  const toast = useToast();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const sw = useSwitchState();
  const busy = signingOut || sw.phase !== "idle";

  /* `&settings=1` opens the menu once on landing, as today's header does; the shell has already dropped it from the address. */
  const { settingsRequested, consumeSettingsRequest } = shell;
  useEffect(() => {
    if (!settingsRequested) return;
    const at = setTimeout(() => { setOpen(true); consumeSettingsRequest(); }, 0);
    return () => clearTimeout(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the request, not the callback's identity, is what this reacts to.
  }, [settingsRequested]);

  /* The house pays in dollars (lib/houseWorkspace.ts): the server hands "usd" to no other workspace. */
  const inDollars = session.rates.unit === "usd";
  const money = useMoney();
  const topups = useRead<Topups>(open && !inDollars ? "/api/workspaces/topups" : null);
  const spend = useRead<unknown>(open && inDollars ? "/api/usage/summary" : null);
  const spentUsd = spentUsdOf(spend.data);
  const canTopUp = Boolean(topups.data?.applies && topups.data.canRequest && topUpPack(topups.data.packs));
  const askAdmin = Boolean(topups.data?.applies && !topups.data.canRequest);
  const balance = creditsLabel(account?.credits?.balance ?? session.credits?.balance ?? null, session.rates.unit, session.rates.creditUsd);
  const current = session.workspace?.id ?? null;
  const others = (session.workspaces ?? []).filter((w) => w.id !== current);
  const items: MenuItem[] = [
    { id: "settings", label: "Workspace settings", onSelect: () => shell.goConsole(), testId: "v12-account-settings" },
    { id: "billing", label: "Credits & billing", onSelect: () => shell.goConsole("billing"), testId: "v12-account-billing" },
    ...others.map((w) => ({
      id: `switch-${w.id}`, label: `Switch to ${w.name}`, disabled: busy,
      /* A full load, as today's menu does (components/graphite/SettingsMenu.tsx): the shell starts again in the other workspace. */
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      onSelect: () => { void switchWorkspace({ id: w.id, fetch: scopedFetch, go: () => window.location.assign("/suites") }).then((why) => { if (why) toast({ text: why }); }); },
    })),
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    ...(session.superAdmin ? [{ id: "platform-desk", label: "Platform desk", onSelect: () => window.location.assign("/admin") }] : []),
    { id: "sep", separator: true },
    {
      id: "sign-out", label: signingOut ? "Signing out…" : "Sign out", tone: "quiet", disabled: busy, testId: "v12-account-signout",
      onSelect: () => {
        setSigningOut(true);
        void signOut(scopedFetch).then((why) => { if (why) { toast({ text: why }); setSigningOut(false); } });
      },
    },
  ];

  return (
    <>
      <Tooltip name="Account" line="Credits, settings, sign out.">
        <button ref={anchor} type="button" className="v12-avatar" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="v12-avatar">
          {avatarInitials({ name: session.name }, account?.workspace?.name)}
        </button>
      </Tooltip>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="Account" align="end" width={240} items={items} testId="v12-account-menu"
        head={(
          <div className="v12-acct-balance">
            {inDollars ? (
              <>
                <span className="v12-acct-credits" title="What this workspace's work has cost at the engines' price, all time. It pays in dollars, not credits." data-testid="v12-account-balance">
                  {spentUsd != null ? `${money.price(spentUsd)} spent` : "In dollars"}
                </span>
                <span className="v12-acct-note" data-testid="v12-account-no-topup">At cost · no top-up</span>
              </>
            ) : (
              <>
                <span className="v12-acct-credits" title={balance.title} data-testid="v12-account-balance">{balance.text}</span>
                {canTopUp ? (
                  <Tooltip name="Top up" line="Ask for credits on Credits & billing.">
                    <button type="button" role="menuitem" tabIndex={-1} className="v12-acct-topup" onClick={() => { setOpen(false); goSettings("credits", "packs"); }} data-testid="v12-account-topup">Top up</button>
                  </Tooltip>
                ) : askAdmin ? <span className="v12-acct-note" data-testid="v12-account-ask-admin">Ask an admin for credits</span> : null}
              </>
            )}
          </div>
        )} />
    </>
  );
}
