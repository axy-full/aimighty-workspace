import { Suspense } from "react";
import { redirect } from "next/navigation";
import BillingClient from "@/components/commercial/BillingClient";
import SuiteAccountShell from "@/components/suites/SuiteAccountShell";
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
    <Suspense fallback={<div className="management">Loading billing…</div>}>
      <SuiteAccountShell initialAccount={account} requestScope={requestScope}>
        <BillingClient
          key={requestScope ?? "visitor"}
          requestScope={requestScope}
        />
      </SuiteAccountShell>
    </Suspense>
  );
}
