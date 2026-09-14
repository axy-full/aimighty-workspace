import { redirect } from "next/navigation";
import { currentContext } from "@/lib/auth";
import {
  accountScopeFor,
  workbenchScopeFor,
} from "@/lib/workbench/request-scope";
import StudioNavigation, {
  StudioDock,
} from "@/components/studio/StudioNavigation";
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
    <div className="shell studio-application">
      <StudioNavigation
        initialAccount={account}
        active="workspace"
        requestScope={scope}
      />
      <div className="shell-body">
        <div className="shell-page">
          <AccountSecurity key={scope} scope={scope} name={context.user.name} requiredBy={context.mfaRequired ? context.workspace?.name : undefined} />
        </div>
      </div>
      <StudioDock />
    </div>
  );
}
