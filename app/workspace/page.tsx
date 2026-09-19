import { redirect } from "next/navigation";
import WorkspaceApp from "@/components/workspace/WorkspaceApp";
import { currentContext } from "@/lib/auth";
import { creditStateFor } from "@/lib/credits";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";
import "../workspace.css";

export const dynamic = "force-dynamic";
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };
export const metadata = { title: "Particl — Workspace" };

/**
 * The redesigned workspace shell. Outside the (app) layout, like /workbench.
 * Signed-out visitors and accounts without a workspace go to /workbench,
 * which already handles both.
 */
export default async function Workspace({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await currentContext();
  if (ctx?.mfaRequired) redirect("/account/security");
  if (!ctx?.workspace) {
    const project = (await searchParams).project;
    redirect("/workbench" + (typeof project === "string" ? "?" + new URLSearchParams({ project }) : ""));
  }
  const credits = await creditStateFor(ctx.workspace).catch(() => null);
  const initialAccount = {
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
    credits: credits ? { balance: credits.balance } : null,
  };
  const scope = workbenchScopeFor(ctx.workspace.id, ctx.user.id);
  return <WorkspaceApp key={scope} scope={scope} initialAccount={initialAccount} />;
}
