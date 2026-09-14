import { Suspense } from "react";
import { redirect } from "next/navigation";
import BillingClient from "@/components/commercial/BillingClient";
import StudioNavigation, {
  StudioDock,
} from "@/components/studio/StudioNavigation";
import { currentContext } from "@/lib/auth";
import { creditStateFor } from "@/lib/credits";
import {
  accountScopeFor,
  workbenchScopeFor,
} from "@/lib/workbench/request-scope";
export const metadata = { title: "Plans & credits · Particl" };
export default async function BillingPage() {
  const context = await currentContext();
  if (context?.mfaRequired) redirect("/account/security");
  const requestScope = context
    ? context.workspace
      ? workbenchScopeFor(context.workspace.id, context.user.id)
      : accountScopeFor(context.user.id)
    : null;
  const account = context
    ? {
        name: context.user.name,
        workspace: context.workspace
          ? { id: context.workspace.id, name: context.workspace.name }
          : null,
        workspaces: context.workspaces,
        credits: context.workspace
          ? await creditStateFor(context.workspace).catch(() => null)
          : null,
      }
    : null;
  return (
    <div className="shell studio-application">
      <StudioNavigation
        initialAccount={account}
        active="workspace"
        requestScope={requestScope}
      />
      <div className="shell-body">
        <div className="shell-page">
          <Suspense
            fallback={<div className="management">Loading billing…</div>}
          >
            <BillingClient
              key={requestScope ?? "visitor"}
              requestScope={requestScope}
            />
          </Suspense>
        </div>
      </div>
      <StudioDock />
    </div>
  );
}
