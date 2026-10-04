import DialogHost from "@/components/dialog";
import UploadRecovery from "@/components/UploadRecovery";
import SuitesApp from "@/components/graphite/SuitesApp";
import { shellBootstrap } from "@/lib/shell/bootstrap.server";
import { SessionProvider } from "@/lib/session";
import { redirect } from "next/navigation";
import { fromMakeLink } from "@/lib/shell/make";
import { searchStringOf } from "@/lib/workspace/switchover";
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
 */
export default async function Suites({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  /* The old Gen page is Make's panel now (lib/shell/make.ts): `?view=gen&mode=…` lands on the same address without them,
     plus `make=<type>`; so do Viral's Motion Transfer and Object Swap (`?suite=subatomik&page=motion|swap`, `sp=…`), as
     `make=motion|swap` over Studio. Before sign-in, so a visitor comes back to Make itself. Viral History stays a page. */
  const moved = fromMakeLink(searchStringOf(await searchParams));
  if (moved !== null) redirect(`/suites${moved ? `?${moved}` : ""}`);
  const { scope, session, initialAccount } = await shellBootstrap(searchParams);
  return (
    <SessionProvider key={scope} value={session}>
      <SuitesApp key={scope} scope={scope} initialAccount={initialAccount} />
      <DialogHost />
      <UploadRecovery scope={scope} />
    </SessionProvider>
  );
}
