import { accountScopeFor, workbenchScopeFor } from "./workbench/request-scope";

/** Account-only controls also need a captured identity before the first workspace exists. */
export function accountRequestScopeMatches(
  request: Request,
  context: { user: { id: string }; workspace: { id: string } | null },
): boolean {
  return request.headers.get("X-Workbench-Scope") === (context.workspace
    ? workbenchScopeFor(context.workspace.id, context.user.id)
    : accountScopeFor(context.user.id));
}
