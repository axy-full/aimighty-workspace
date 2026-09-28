"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ManagementCard, ManagementNotice } from "./ManagementPage";
import styles from "./workspace-audit.module.css";

type AuditEvent = {
  id: string;
  workspaceId: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: number;
  details: {
    role?: string;
    disabled?: boolean;
    unlocked?: boolean;
    mode?: string;
    scope?: string;
    expiresAt?: number;
  };
};
type AuditPage = {
  events: AuditEvent[];
  nextCursor: string | null;
  actors: Record<string, string>;
};
export const labels: Record<string, string> = {
  "session.created": "Signed in",
  "session.revoked": "Signed out",
  "session.workspace_changed": "Switched workspace",
  "account.password_reset": "Reset password",
  "account.mfa_enabled": "Enabled two-step sign-in",
  "account.mfa_replaced": "Replaced authenticator",
  "account.mfa_disabled": "Disabled two-step sign-in",
  "account.recovery_codes_rotated": "Replaced recovery codes",
  "account.recovery_code_used": "Used a recovery code",
  "account.sessions_revoked": "Ended account sessions",
  "member.updated": "Changed member access",
  "member.removed": "Removed member",
  "vendor_key.updated": "Updated provider key",
  "vendor_key.removed": "Removed provider key",
  "workspace.mode_changed": "Changed model access",
  "workspace.mfa_required": "Required workspace two-step sign-in",
  "workspace.mfa_optional": "Made workspace two-step sign-in optional",
  "workspace.restored": "Restored the workspace",
  "api_token.created": "Created API token",
  "api_token.revoked": "Revoked API token",
  "review_link.created": "Created review link",
  "review_link.revoked": "Revoked review link",
};
const targetLabels: Record<string, string> = {
  account: "Account",
  member: "Member",
  workspace: "Workspace",
  vendor: "Provider",
  api_token: "API token",
  review_link: "Review link",
};
const empty: AuditPage = { events: [], nextCursor: null, actors: {} };

export default function WorkspaceAudit({ scope }: { scope: string }) {
  const [page, setPage] = useState<AuditPage>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef<AbortController | null>(null);
  const read = useCallback(
    async (cursor?: string, signal?: AbortSignal): Promise<AuditPage> => {
      const query = new URLSearchParams({ limit: "30" });
      if (cursor) query.set("before", cursor);
      const response = await fetch(`/api/workspaces/audit?${query}`, {
        headers: { "X-Workbench-Scope": scope },
        cache: "no-store",
        signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          result.error || "Activity could not be loaded. Try again.",
        );
      if (
        !Array.isArray(result.events) ||
        !result.actors ||
        typeof result.actors !== "object"
      )
        throw new Error("The activity response could not be read. Try again.");
      return result;
    },
    [scope],
  );
  useEffect(() => {
    const controller = new AbortController();
    inFlight.current = controller;
    void read(undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setPage(result);
          setError("");
        }
      })
      .catch((problem) => {
        if (!controller.signal.aborted) {
          setFailedCursor(null);
          setError(
            problem instanceof Error
              ? problem.message
              : "Activity could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      inFlight.current?.abort();
    };
  }, [read, revision]);
  function refresh() {
    setLoading(true);
    setError("");
    setRevision((value) => value + 1);
  }
  async function more() {
    if (!page.nextCursor || loading) return;
    setLoading(true);
    setError("");
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const next = await read(page.nextCursor, controller.signal);
      if (!controller.signal.aborted)
        setPage((current) => ({
          events: [
            ...current.events,
            ...next.events.filter(
              (event) =>
                !current.events.some((existing) => existing.id === event.id),
            ),
          ],
          actors: { ...current.actors, ...next.actors },
          nextCursor: next.nextCursor,
        }));
    } catch (problem) {
      if (!controller.signal.aborted) {
        setFailedCursor(page.nextCursor);
        setError(
          problem instanceof Error
            ? problem.message
            : "Activity could not be loaded.",
        );
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <ManagementCard
      title="Workspace activity"
      description="Committed account, access and security changes. Credentials and creative content are excluded."
      action={
        <button
          className="management-button small"
          disabled={loading}
          onClick={refresh}
        >
          Refresh activity
        </button>
      }
    >
      {error && (
        <ManagementNotice error>
          {error}
          <button
            className="management-button small"
            disabled={loading}
            onClick={failedCursor ? () => void more() : refresh}
          >
            Retry activity
          </button>
        </ManagementNotice>
      )}
      {loading && <p role="status">Loading activity…</p>}
      {!loading && !error && !page.events.length && (
        <p className="management-muted">
          No recorded activity yet. New committed changes will appear here.
        </p>
      )}
      {!!page.events.length && (
        <ol className={styles.events} aria-label="Workspace activity entries">
          {page.events.map((event) => {
            const actor =
              event.actorId === null
                ? "System"
                : page.actors[event.actorId] || "Former member";
            const details: string[] = [];
            if (event.details.role) details.push(`Role: ${event.details.role}`);
            if (event.details.disabled !== undefined)
              details.push(
                event.details.disabled ? "Access disabled" : "Access enabled",
              );
            if (event.details.unlocked) details.push("Account unlocked");
            if (event.details.mode)
              details.push(
                event.details.mode === "platform"
                  ? "Particl model access"
                  : "Own provider keys",
              );
            if (event.details.scope)
              details.push(`Permission: ${event.details.scope}`);
            if (event.details.expiresAt)
              details.push(
                `Expires ${new Date(event.details.expiresAt).toLocaleString()}`,
              );
            return (
              <li key={event.id}>
                <div>
                  <strong>{labels[event.action] || "Workspace changed"}</strong>
                  <p>{actor}</p>
                  {event.targetId && (
                    <small>
                      {targetLabels[event.targetType] || "Record"}:{" "}
                      {event.targetType === "account" ||
                      event.targetType === "member"
                        ? page.actors[event.targetId] || "Former member"
                        : event.targetId}
                    </small>
                  )}
                  {!!details.length && (
                    <p className={styles.details}>{details.join(" · ")}</p>
                  )}
                </div>
                <time dateTime={new Date(event.createdAt).toISOString()}>
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </li>
            );
          })}
        </ol>
      )}
      {page.nextCursor && (
        <button
          className="management-button"
          disabled={loading}
          onClick={() => void more()}
        >
          Load older activity
        </button>
      )}
    </ManagementCard>
  );
}
