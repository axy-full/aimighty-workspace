import { redirect } from "next/navigation";
import { currentContext } from "@/lib/auth";
import {
  accountScopeFor,
  workbenchScopeFor,
} from "@/lib/workbench/request-scope";
import SuiteAccountShell from "@/components/suites/SuiteAccountShell";
import AccountSecurity from "@/components/management/AccountSecurity";
export const metadata = { title: "Account security · Particl" };
export const dynamic = "force-dynamic";
export default async function AccountSecurityPage() {
  const context = await currentContext();
  if (!context) redirect("/login?next=/account/security");
  const scope = context.workspace
    ? workbenchScopeFor(context.workspace.id, context.user.id)
    : accountScopeFor(context.user.id);
  const account = {
    name: context.user.name,
    workspace: context.workspace
      ? { id: context.workspace.id, name: context.workspace.name }
      : null,
    workspaces: context.workspaces,
    credits: null,
  };
  return (
    <Suspense
      fallback={<div className="management">Loading account security…</div>}
    >
      <SuiteAccountShell initialAccount={account} requestScope={scope}>
        <AccountSecurity
          key={scope}
          scope={scope}
          name={context.user.name}
          requiredBy={context.mfaRequired ? context.workspace?.name : undefined}
        />
      </SuiteAccountShell>
    </Suspense>
  );
}
import { Suspense } from "react";
