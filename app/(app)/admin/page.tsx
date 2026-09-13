"use client";

import { usePhone } from "@/lib/usePhone";
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { Chip, Mono, PinnedBar, PinnedPrimary, ToastHost } from "@/components/ui";
import { PageLoader } from "@/components/atomik/Loader";
import WantsIn, { useSendCodes } from "@/components/admin/WantsIn";
import Engines from "@/components/admin/Engines";
import Studios from "@/components/admin/Studios";
import Defaults from "@/components/admin/Defaults";
import DefaultsSheet from "@/components/admin/DefaultsSheet";
import { TopupsCard, ReportsCard, PreviewsCard } from "@/components/admin/Levers";
import { monthLabel, subBarLine } from "@/components/admin/adminFormat";
import type { Admin, LayerView } from "@/components/admin/types";

/**
 * The platform's desk (SOW surfaces board 12h; SOW v2 §7.13): the one
 * screen only the platform's owner opens. Under the shell header a
 * sub-bar — the `PLATFORM · ADMIN` chip and one mono line of the month:
 * `SEPTEMBER · ENGINE SPEND $4,820 · MARGIN 33% · GRANTS $410 OF $1,000`
 * — then a two-column grid (`26px 28px 40px`, 16 apart) of `--card`
 * blocks: Wants in, Engines, Studios across both columns, and What every
 * new studio starts with; beneath them the v1 desk's remaining levers as
 * further blocks. One filled primary: `Send N codes`, with the grant
 * beside it — outlined while the defaults sheet or a studio's ⋯ is open,
 * when the budget will not take the codes, and when there is nobody to
 * send to; blocked until the deployment can provision a workspace. Every
 * figure is read from the platform's own routes — the grant, the invite
 * days, the multiplier, the margins; the desk types none of them, and the
 * lines it prints are lib/adminView's, the month the cycle's UTC month.
 * Internal studios bill at cost and are left out of every margin. Nothing
 * is red: a bad number reads in ink. The ring is the only loader.
 *
 * Below 768: the M10 header (`‹ Back · Admin`), one column at 16px,
 * the studios stacked, every switch on a 44pt band, `Send N codes`
 * pinned above the dock, and the defaults editor as a sheet from 44px.
 *
 * Gated as before: `session.superAdmin`, which is the platform's owner;
 * everyone else sees one line, and every route behind this desk answers
 * 401 or 403 on its own.
 */
export default function AdminPage() {
  return <ToastHost><Desk /></ToastHost>;
}

function Desk() {
  usePageTitle("Platform");
  const { superAdmin } = useSession();
  const { data, refresh } = useApi<Admin>(superAdmin ? "/api/admin/invites" : null, 30_000);
  const { data: layer, refresh: refreshLayer } = useApi<LayerView>(superAdmin ? "/api/admin/platform-layer" : null, 60_000);
  const [editing, setEditing] = useState(false);

  if (!superAdmin) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
        <div className="flex flex-col gap-[6px] px-[28px] pt-[26px] max-md:px-[16px] max-md:pt-[16px]">
          <span className="text-[16px] font-semibold leading-none text-ink">The platform owner only</span>
          <span className="text-[13px] leading-[1.4] text-ink-body">This desk administers sign-ups for the whole deployment.</span>
        </div>
      </div>
    );
  }
  if (!data) return <PageLoader what="Reading · Platform" />;
  return <Loaded data={data} refresh={refresh} layer={layer} refreshLayer={refreshLayer} editing={editing} setEditing={setEditing} />;
}

function Loaded({ data, refresh, layer, refreshLayer, editing, setEditing }: {
  data: Admin; refresh: () => void; layer: LayerView | null; refreshLayer: () => void; editing: boolean; setEditing: (v: boolean) => void;
}) {
  const codes = useSendCodes(data, refresh);
  const money = useMoney();
  const [menuOpen, setMenuOpen] = useState(false);
  /* A sheet is open: the defaults editor, or a studio's ⋯ (a sheet below 768). The primary outlines meanwhile. */
  const phone = usePhone();
  /* A rail or a sheet outlines the page's primary (README §5); on a desktop the ⋯ is a popover, not a sheet. */
  const sheetOpen = editing || (menuOpen && phone);
  const t = data.totals;
  /* The sub-bar line, from the cycle the route answered; a route a version behind gives the month alone, or nothing — never the viewer's clock. */
  const line = t && data.cycle
    ? subBarLine({ cycleStart: data.cycle.start, engineCostUsd: t.engineCostUsd, marginPct: t.marginPct, grantsUsd: t.grantsUsd, grantBudgetUsd: t.grantBudgetUsd })
    : data.cycle ? monthLabel(data.cycle.start).toUpperCase() : "—";
  const peaks = Object.fromEntries((data.concurrency?.byEngine ?? []).map((e) => [e.engine, e.peak]));
  const grantCredits = data.grant?.credits ?? data.signupCredits;
  /* The pinned primary's cost is the grant in the desk's own unit, like the card's. */
  const pinnedCost = `${money.price(money.inCredits ? codes.grant.credits : codes.grant.usdEach)} each`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ground text-ink">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-phone-body="">
        <div className="flex flex-none flex-wrap items-center gap-x-[12px] gap-y-[8px] border-b border-border px-[28px] py-[10px] max-md:px-[16px]" data-desk-bar="">
          <Chip variant="mono" className="!text-ink-muted">Platform · Admin</Chip>
          <Mono className="ml-auto min-w-0 max-md:ml-0 max-md:basis-full max-md:!leading-[1.6]" data-desk-line="">{line}</Mono>
        </div>
        {/* Two columns from 1280 (the board is drawn at 1440); one below, so no card is narrower than its rows. */}
        <div className="grid grid-cols-2 content-start gap-[16px] px-[28px] pb-[40px] pt-[26px] max-xl:grid-cols-1 max-md:px-[16px] max-md:pb-[16px] max-md:pt-[16px]" data-desk-grid="">
          <WantsIn data={data} onChanged={refresh} codes={codes} sheetOpen={sheetOpen} />
          <Engines peaks={peaks} />
          <Studios data={data} onChanged={refresh} onMenu={setMenuOpen} />
          <Defaults view={layer} grantCredits={grantCredits} onEdit={() => setEditing(true)} />
          <TopupsCard onChanged={refresh} />
          <ReportsCard />
          <div className="col-span-2 max-xl:col-span-1"><PreviewsCard /></div>
        </div>
      </div>
      <PinnedBar>
        <PinnedPrimary cost={pinnedCost} outlined={!codes.fits || codes.n === 0 || sheetOpen} disabled={codes.n === 0 || !data.ready} busy={codes.busy} onClick={codes.send} label={codes.label}>{codes.label}</PinnedPrimary>
      </PinnedBar>
      {layer && <DefaultsSheet open={editing} onClose={() => setEditing(false)} view={layer} refresh={refreshLayer} />}
    </div>
  );
}
