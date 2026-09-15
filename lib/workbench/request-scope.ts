/** An account and workspace captured when the workbench document was rendered. */
export function workbenchScopeFor(workspaceId: string, userId: string) {
  return `particl-active-${workspaceId}-${userId}`;
}

/** A verified account that has not selected or provisioned a workspace yet. */
export function accountScopeFor(userId: string) {
  return `particl-account-${userId}`;
}

/** Check before parsing private content or starting any read, write or paid claim. */
export function workbenchScopeProblem(
  request: Request,
  workspaceId: string,
  userId: string,
  required = false,
): string | null {
  const captured = request.headers.get("X-Workbench-Scope");
  if (!captured && !required) return null;
  return captured === workbenchScopeFor(workspaceId, userId)
    ? null
    : "Your account or workspace changed. Return to the original account before saving this project, or download your current work.";
}
