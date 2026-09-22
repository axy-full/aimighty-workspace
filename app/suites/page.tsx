import DialogHost from "@/components/dialog";
import UploadRecovery from "@/components/UploadRecovery";
import SuitesApp from "@/components/graphite/SuitesApp";
import { shellBootstrap } from "@/lib/shell/bootstrap.server";
import { SessionProvider } from "@/lib/session";
import "../workspace.css";
import "../graphite.css";
import "../flair.css";
import "../crew.css";
import "../glass.css";
import "../business.css";
import "../viral.css";

export const dynamic = "force-dynamic";
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };
export const metadata = { title: "Particl" };

/**
 * The Particl Suites shell (design/particl-suites/README.md) — the surface
 * every old entry point lands on since 22 September 2026
 * (lib/workspace/switchover.ts › SHELL_PATH). workspace.css rides along because
 * the page bodies it mounts today are the existing ones, inside the new chrome.
 */
export default async function Suites({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { scope, session, initialAccount } = await shellBootstrap(searchParams);
  return (
    <SessionProvider key={scope} value={session}>
      <SuitesApp key={scope} scope={scope} initialAccount={initialAccount} />
      <DialogHost />
      <UploadRecovery scope={scope} />
    </SessionProvider>
  );
}
