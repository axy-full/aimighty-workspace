"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ManagementCard, ManagementNotice } from "./ManagementPage";
import styles from "./account-security.module.css";

type Policy = {
  requiresMfa: boolean;
  ownerEnrolled: boolean;
  members: number;
  unenrolled: number;
};
export default function WorkspaceSecurity() {
  const scopedFetch = useScopedFetch();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [password, setPassword] = useState(""),
    [code, setCode] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const read = useCallback(
    async (signal?: AbortSignal) => {
      const response = await scopedFetch("/api/workspaces/security", {
        cache: "no-store",
        signal,
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(value.error || "Workspace policy could not be loaded.");
      return value as Policy;
    },
    [scopedFetch],
  );
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPolicy(value);
      })
      .catch((problem) => {
        if (!controller.signal.aborted) setError(problem.message);
      });
    return () => controller.abort();
  }, [read]);
  async function refresh() {
    setError("");
    try {
      setPolicy(await read());
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Workspace policy could not be loaded.",
      );
    }
  }
  async function save() {
    if (!policy || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await scopedFetch("/api/workspaces/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requiresMfa: !policy.requiresMfa,
          password,
          code,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          result.error ||
            "Policy change could not be confirmed. Refresh its status before retrying.",
        );
      setPolicy(await read());
      setNotice(
        result.requiresMfa
          ? "Two-step sign-in is now required for this workspace."
          : "Members can now choose their own two-step sign-in setting.",
      );
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Policy change could not be confirmed.",
      );
      try {
        setPolicy(await read());
      } catch {
        /* Keep the previous state visibly accompanied by the error. */
      }
    } finally {
      setPassword("");
      setCode("");
      setBusy(false);
    }
  }
  return (
    <ManagementCard
      title="Workspace sign-in policy"
      description="Require an authenticator for every workspace member."
    >
      {error && (
        <ManagementNotice error>
          {error}{" "}
          <button
            className="management-button small"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh policy
          </button>
        </ManagementNotice>
      )}
      {notice && <ManagementNotice>{notice}</ManagementNotice>}
      {!policy ? (
        <p>Loading workspace policy…</p>
      ) : (
        <>
          <div className={styles.status}>
            <strong>
              {policy.requiresMfa
                ? "Required for all members"
                : "Optional for members"}
            </strong>
          </div>
          <p>
            {policy.members - policy.unenrolled} of {policy.members} active
            members have enrolled. Members without an authenticator must
            complete setup before opening studio data. Their API tokens also
            pause until they enrol.
          </p>
          {!policy.ownerEnrolled ? (
            <Link href="/account/security" className="management-button">
              Set up your authenticator first
            </Link>
          ) : (
            <>
              <div className={styles.fields}>
                <label>
                  Owner password
                  <input
                    className="management-input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <label>
                  Fresh authenticator or recovery code
                  <input
                    className="management-input"
                    autoComplete="one-time-code"
                    maxLength={24}
                    value={code}
                    disabled={busy}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
              </div>
              <button
                className="management-button primary"
                disabled={busy || !password || !code}
                onClick={() => void save()}
              >
                {busy
                  ? "Saving policy…"
                  : policy.requiresMfa
                    ? "Make two-step sign-in optional"
                    : "Require two-step sign-in"}
              </button>
            </>
          )}
        </>
      )}
    </ManagementCard>
  );
}
