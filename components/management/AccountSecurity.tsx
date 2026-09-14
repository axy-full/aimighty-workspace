"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, KeyRound, Monitor } from "lucide-react";
import ManagementPage, {
  ManagementCard,
  ManagementNotice,
} from "./ManagementPage";
import styles from "./account-security.module.css";

type SecurityState = {
  enabled: boolean;
  requiredWorkspaces?: { id: string; name: string }[];
  enabledAt: number | null;
  recoveryCodesRemaining: number;
  pendingRecoveryBatch: string | null;
  recoveryReplacementAuthorizedUntil: number | null;
  sessions: {
    id: string;
    label: string;
    current: boolean;
    createdAt: number;
    expiresAt: number;
  }[];
};
type Setup = { secret: string; uri: string; expiresAt: number };
export default function AccountSecurity({
  scope,
  name,
  requiredBy,
}: {
  scope: string;
  name: string;
  requiredBy?: string;
}) {
  const [state, setState] = useState<SecurityState | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [setup, setSetup] = useState<Setup | null>(null),
    [codes, setCodes] = useState<string[]>([]),
    [batchId, setBatchId] = useState<string | null>(null);
  const read = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch("/api/account/security", {
        headers: { "X-Workbench-Scope": scope },
        cache: "no-store",
        signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          result.error || "Account security could not be loaded.",
        );
      if (
        !Array.isArray(result.sessions) ||
        typeof result.enabled !== "boolean"
      )
        throw new Error("The account security response could not be read.");
      return result as SecurityState;
    },
    [scope],
  );
  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState(value);
      })
      .catch((problem) => {
        if (!controller.signal.aborted) setError(problem.message);
      });
    return () => controller.abort();
  }, [read]);
  async function change(action: string, sessionId?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/account/security", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workbench-Scope": scope,
        },
        body: JSON.stringify({ action, password, code, sessionId, batchId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          result.error || "This security change could not be saved.",
        );
      if (result.setup) setSetup(result.setup);
      else {
        setSetup(null);
        if (!result.batchId) setPassword("");
        setCode("");
      }
      if (result.recoveryCodes) {
        setCodes(result.recoveryCodes);
        setBatchId(result.batchId ?? null);
      }
      if (action === "activate_codes") {
        setCodes([]);
        setBatchId(null);
      }
      setNotice(
        action === "begin"
          ? "Add this key to your authenticator, then enter its code to finish setup."
          : action === "enable"
            ? "Two-step sign-in is enabled. Every previous session has ended; this browser received a new session."
            : action === "disable"
              ? "Two-step sign-in is off. Recovery codes and previous sessions have been revoked."
              : action === "rotate_codes"
                ? "Save the new recovery codes, then confirm to activate them. Your unused old codes continue to work until then."
                : action === "activate_codes"
                  ? "Your saved recovery codes are active. Old recovery codes have been revoked."
                  : "The selected sessions have ended.",
      );
      const fresh = await read();
      setState(fresh);
      if (
        action !== "rotate_codes" &&
        batchId &&
        fresh.pendingRecoveryBatch !== batchId
      ) {
        setCodes([]);
        setBatchId(null);
      }
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "This security change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setError("");
    try {
      const fresh = await read();
      setState(fresh);
      if (batchId && fresh.pendingRecoveryBatch !== batchId) {
        setCodes([]);
        setBatchId(null);
        setNotice(
          "The displayed recovery-code set changed. Prepare a new set below.",
        );
      }
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not refresh security settings.",
      );
    }
  }
  return (
    <ManagementPage
      tab="workspace"
      title="Account security"
      workspace={name}
      description="Protect your sign-in across all your production workspaces."
    >
      <div className={styles.layout}>
        {requiredBy && (
          <ManagementNotice>
            {state?.enabled
              ? "Your authenticator is ready. Save your recovery codes before continuing."
              : `${requiredBy} requires two-step sign-in. Set up your authenticator to open this workspace.`}
            {state?.enabled && !codes.length && (
              <a href="/workbench" className="management-button primary">
                Continue to workspace
              </a>
            )}
          </ManagementNotice>
        )}
        {error && (
          <ManagementNotice error>
            {error}{" "}
            <button
              className="management-button"
              onClick={() => void refresh()}
              disabled={busy}
            >
              Refresh status
            </button>
            <Link
              href="/login?next=/account/security"
              className="management-button"
            >
              Sign in again
            </Link>
          </ManagementNotice>
        )}
        {notice && <ManagementNotice>{notice}</ManagementNotice>}
        {!state ? (
          <ManagementNotice>Loading account security…</ManagementNotice>
        ) : (
          <>
            <ManagementCard
              title="Two-step sign-in"
              description="Use an authenticator app alongside your password."
            >
              <div className={styles.status}>
                <ShieldCheck size={22} />
                <strong>{state.enabled ? "Enabled" : "Not enabled"}</strong>
              </div>
              <p>
                Security changes require your current password
                {state.enabled
                  ? " and a fresh authenticator or recovery code"
                  : ""}
                .
              </p>
              <div className={styles.fields}>
                <label>
                  Current password
                  <input
                    className="management-input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                  />
                </label>
                {(state.enabled || setup) && (
                  <label>
                    Authenticator or recovery code
                    <input
                      className="management-input"
                      type="text"
                      autoComplete="one-time-code"
                      maxLength={24}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                )}
              </div>
              {setup ? (
                <div className={styles.setup}>
                  <h3>Add Particl to your authenticator</h3>
                  <p>
                    Choose a time-based account and enter this setup key. Finish
                    within ten minutes.
                  </p>
                  <label>
                    Setup key
                    <input
                      className="management-input"
                      readOnly
                      value={setup.secret}
                      spellCheck={false}
                    />
                  </label>
                  <a className="management-button" href={setup.uri}>
                    Open authenticator
                  </a>
                  <button
                    className="management-button primary"
                    disabled={busy || !password || !code}
                    onClick={() => void change("enable")}
                  >
                    Enable two-step sign-in
                  </button>
                </div>
              ) : (
                <div className="management-actions">
                  {!state.enabled ? (
                    <button
                      className="management-button primary"
                      disabled={busy || !password}
                      onClick={() => void change("begin")}
                    >
                      <KeyRound size={14} /> Set up authenticator
                    </button>
                  ) : (
                    <button
                      className="management-button danger"
                      disabled={
                        busy ||
                        !password ||
                        !code ||
                        Boolean(state.requiredWorkspaces?.length)
                      }
                      onClick={() => void change("disable")}
                    >
                      Turn off two-step sign-in
                    </button>
                  )}
                </div>
              )}
              {Boolean(state.requiredWorkspaces?.length) && (
                <p>
                  Two-step sign-in is required by{" "}
                  {state.requiredWorkspaces!.map((w) => w.name).join(", ")}. It
                  cannot be turned off while that membership requires it.
                </p>
              )}
            </ManagementCard>
            {state.enabled && (
              <ManagementCard
                title="Recovery codes"
                description={`${state.recoveryCodesRemaining} unused codes remain. Each code can replace your authenticator once.`}
              >
                {state.recoveryReplacementAuthorizedUntil != null && (
                  <p>
                    You signed in with a recovery code. Use your current
                    password to prepare a replacement set before{" "}
                    {new Date(
                      state.recoveryReplacementAuthorizedUntil,
                    ).toLocaleTimeString()}
                    . This permission can be used once in this browser.
                  </p>
                )}
                {codes.length > 0 ? (
                  <div className={styles.recovery}>
                    <p>
                      Save these codes in your password manager or print a copy.
                      A replacement set can be resumed from this browser until
                      you confirm it is saved.
                    </p>
                    <ul aria-label="New recovery codes">
                      {codes.map((value) => (
                        <li key={value}>
                          <code>{value}</code>
                        </li>
                      ))}
                    </ul>
                    <button
                      className="management-button"
                      disabled={busy || Boolean(batchId && !password)}
                      onClick={() => {
                        if (batchId) {
                          void change("activate_codes");
                          return;
                        }
                        setCodes([]);
                        setNotice(
                          "Recovery codes hidden. Keep your saved copy somewhere safe.",
                        );
                      }}
                    >
                      I have saved my recovery codes
                    </button>
                    {batchId && !password && (
                      <p>
                        Enter your current password above to activate this saved
                        set.
                      </p>
                    )}
                    {batchId && (
                      <button
                        className="management-button"
                        disabled={busy}
                        onClick={() => {
                          setCodes([]);
                          setBatchId(null);
                          void refresh();
                        }}
                      >
                        Close displayed set
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    className="management-button"
                    disabled={
                      busy ||
                      !password ||
                      (!state.pendingRecoveryBatch &&
                        !state.recoveryReplacementAuthorizedUntil &&
                        !code)
                    }
                    onClick={() => void change("rotate_codes")}
                  >
                    {state.pendingRecoveryBatch
                      ? "Resume recovery code replacement"
                      : "Replace recovery codes"}
                  </button>
                )}
              </ManagementCard>
            )}
            <ManagementCard
              title="Signed-in sessions"
              description="Review active browser sessions and end access you no longer need."
            >
              <div className={styles.sessions}>
                {state.sessions.map((session) => (
                  <div className={styles.session} key={session.id}>
                    <Monitor size={18} />
                    <div>
                      <strong>
                        {session.label}
                        {session.current ? " · This browser" : ""}
                      </strong>
                      <p>
                        Signed in {new Date(session.createdAt).toLocaleString()}
                        <br />
                        Expires{" "}
                        {new Date(session.expiresAt).toLocaleDateString()}
                      </p>
                    </div>
                    {!session.current && (
                      <button
                        className="management-button"
                        disabled={busy || !password || (state.enabled && !code)}
                        onClick={() =>
                          void change("revoke_session", session.id)
                        }
                      >
                        End session
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                className="management-button"
                disabled={
                  busy ||
                  !password ||
                  (state.enabled && !code) ||
                  state.sessions.length < 2
                }
                onClick={() => void change("revoke_others")}
              >
                End all other sessions
              </button>
            </ManagementCard>
          </>
        )}
      </div>
    </ManagementPage>
  );
}
