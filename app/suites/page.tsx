import DialogHost from "@/components/dialog";
import UploadRecovery from "@/components/UploadRecovery";
import SuitesApp from "@/components/graphite/SuitesApp";
import { redirect } from "next/navigation";
import { shellBootstrap } from "@/lib/shell/bootstrap.server";
import { SHELL_PATH, redirectFor } from "@/lib/shell/ia";
import { fromMakeLink } from "@/lib/shell/make";
import { route, sameSearch } from "@/lib/shell/screens";
import { searchStringOf } from "@/lib/workspace/switchover";
import { SessionProvider } from "@/lib/session";
import "@/components/workspace/workspace.css";
import "@/components/graphite/shell.css";
import "@/components/graphite/crew/crew.css";
import "@/components/graphite/production/production.css";
import "@/components/graphite/business/business.css";
import "@/components/graphite/viral/viral.css";
import "@/components/graphite/phone.css";
import "@/components/graphite/make.css";

export const dynamic = "force-dynamic";
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };
export const metadata = { title: "Particl" };

/**
 * The Particl Suites shell (design/particl-graphite/README.md) — the surface
 * every old entry point lands on since 22 September 2026
 * (lib/workspace/switchover.ts › SHELL_PATH). workspace.css rides along because
 * the page bodies it mounts today are the existing ones, inside the new chrome.
 * An old link in the design file's spelling is sent to the app's first
 * (lib/shell/ia.ts › redirectFor; a 307, the server redirect()'s own).
 */
export default async function Suites({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  /* Old links land in one 307, never a chain: the design file's spellings become the app's (lib/shell/ia.ts ›
     redirectFor), then the old Gen page's address (`?view=gen&mode=…`) and Viral's Motion Transfer and Object Swap
     (`?suite=subatomik&page=motion|swap`, `sp=…`) are Make's panel (lib/shell/make.ts › fromMakeLink): the same address
     without them, plus `make=<type>` or `make=motion|swap` over Studio. Before sign-in, so a visitor comes back to Make
     itself. Viral History stays a page. */
  const asked = searchStringOf(await searchParams);
  const spelled = redirectFor(SHELL_PATH, asked);
  const moved = fromMakeLink(spelled === null ? asked : spelled.slice(SHELL_PATH.length));
  const to = moved === null ? spelled : `${SHELL_PATH}${moved ? `?${moved}` : ""}`;
  if (to) redirect(to);
  const { scope, session, initialAccount } = await shellBootstrap(searchParams);
  /* The screen registry (lib/shell/screens.ts): an old address opens its screen, and a bare landing opens Home. One more 307,
     only when something moves, and only now: the session is read first. */
  const routed = route(asked);
  if (!sameSearch(routed, asked)) redirect(`${SHELL_PATH}${routed}`);
  return (
    <SessionProvider key={scope} value={session}>
      <SuitesApp key={scope} scope={scope} initialAccount={initialAccount} />
      <DialogHost />
      <UploadRecovery scope={scope} />
    </SessionProvider>
  );
}
