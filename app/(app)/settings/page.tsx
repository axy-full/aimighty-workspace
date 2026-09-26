"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Building2, Download, ShieldCheck } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { usePageLeaveGuard, withPageLeaveGuard } from "@/lib/usePageLeaveGuard";
import { MODELS, estimateTokens, costUsd } from "@/lib/models";
import { estimateVideo, estimateImage } from "@/lib/rateTable";
import {
  NOTIFY_KINDS,
  NOTIFY_LABELS,
  type NotifyKind,
} from "@/lib/notifyPrefs";
import { appAlert, appPrompt } from "@/components/dialog";
import ManagementPage, {
  ManagementCard,
  ManagementNotice,
} from "@/components/management/ManagementPage";
import WorkspaceAudit from "@/components/management/WorkspaceAudit";
import OpenAIConnection from "@/components/management/OpenAIConnection";
import HiggsfieldConnection from "@/components/management/HiggsfieldConnection";
import HiggsfieldConsumerConnection from "@/components/management/HiggsfieldConsumerConnection";

type Me = {
  name: string;
  email: string;
  role: string;
  owner?: boolean;
  credits?: { balance: number } | null;
  workspace?: { id: string; name: string } | null;
};
type Settings = {
  settings: Record<string, string>;
  defaults: Record<string, string>;
  models?: { video: string; image: string } | null;
};
type Engines = {
  engines: {
    id: string;
    label: string;
    configured: boolean;
    models: { id: string; label: string; kind: string }[];
  }[];
  refiner?: { writer: string; label: string; pricePerCall?: number | null };
};
const tabs = [
  ["general", "General"],
  ["defaults", "Production"],
  ["engines", "Engines"],
  ["storage", "Files & assets"],
  ["notifications", "Notifications"],
  ["account", "Account"],
  ["activity", "Activity"],
] as const;
const gb = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;
const PUSH_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
function urlB64ToUint8Array(value: string) {
  const b64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from([...atob(b64)].map((c) => c.charCodeAt(0)));
}
function Row({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: string;
  children: ReactNode;
  gap?: boolean;
}) {
  return (
    <div className="management-row">
      <div>
        <strong>{label}</strong>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
function Switch({
  on,
  onChange,
  label,
  disabled = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="management-toggle"
    >
      <span />
    </button>
  );
}
export default function SettingsPage() {
  const session = useSession();
  return <SettingsContent key={`${session.workspace?.id}:${session.email}`} />;
}
function SettingsContent() {
  const scopedFetch = useScopedFetch();
  usePageTitle("Workspace");
  const router = useRouter();
  const session = useSession();
  const money = useMoney();
  const {
    data: me,
    error: meError,
    refresh: refreshMe,
  } = useApi<Me>("/api/me");
  const {
    data: settings,
    error: settingsError,
    refresh,
  } = useApi<Settings>("/api/settings");
  const { data: engines } = useApi<Engines>("/api/engines");
  const { data: limits } = useApi<{
    limits: { storageBytes: number };
    standing: { usedBytes: number };
  }>("/api/limits");
  const { data: notify, refresh: refreshNotify } = useApi<{
    prefs: Record<NotifyKind, boolean>;
  }>("/api/me/notify");
  const [tab, setTab] = useState("general"),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({}),
    [nameDraft, setNameDraft] = useState<string | null>(null);
  const admin = me?.role === "admin",
    owner = Boolean(me?.owner);
  const value = (key: string) =>
    draft[key] ?? settings?.settings[key] ?? settings?.defaults[key] ?? "";
  const edit = (key: string, next: string) =>
    setDraft((before) => ({ ...before, [key]: next }));
  const dirty = Object.keys(draft).length > 0;
  useEffect(() => {
    const selectHash = () => {
      const target = window.location.hash.slice(1);
      if (tabs.some(([id]) => id === target)) setTab(target);
      if (target === "credits")
        requestAnimationFrame(() =>
          document
            .getElementById("credits")
            ?.scrollIntoView({ block: "start" }),
        );
    };
    Promise.resolve().then(selectHash);
    window.addEventListener("hashchange", selectHash);
    return () => window.removeEventListener("hashchange", selectHash);
  }, [settings]);
  const workspaceName = nameDraft ?? me?.workspace?.name ?? "";
  const nameChanged = nameDraft != null && nameDraft !== me?.workspace?.name;
  usePageLeaveGuard(dirty || nameChanged);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (nameChanged) {
        const r = await scopedFetch("/api/workspaces", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: workspaceName.trim() }),
        });
        const body = await r.json();
        if (!r.ok)
          throw new Error(body.error || "Workspace name could not be saved.");
        await refreshMe();
        setNameDraft(null);
        router.refresh();
      }
      if (dirty) {
        const r = await scopedFetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        const body = await r.json();
        if (!r.ok)
          throw new Error(body.error || "Settings could not be saved.");
        await refresh();
        setDraft({});
      }
      setNotice("Workspace changes saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setNotify(kind: NotifyKind, on: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await scopedFetch("/api/me/notify", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, on }),
      });
      if (!r.ok) throw new Error("Notification preference could not be saved.");
      await refreshNotify();
      setNotice("Notification preference saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await withPageLeaveGuard(async () => {
        const r = await scopedFetch("/api/auth/logout", { method: "POST" });
        if (!r.ok) throw new Error("Sign out failed. Try again.");
        router.push("/login");
        router.refresh();
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteWorkspace() {
    const name = me?.workspace?.name ?? "";
    const typed = await appPrompt(
      `Delete “${name}”?`,
      "",
      name,
      "The team will lose access and its media and database will be removed. Billing records are retained. Type the workspace name to confirm.",
    );
    if (typed == null) return;
    setBusy(true);
    setError("");
    try {
      const r = await scopedFetch("/api/workspaces", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: typed }),
      });
      const body = await r.json();
      if (!r.ok)
        throw new Error(body.error || "Workspace could not be deleted.");
      window.location.assign("/workbench");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const models = MODELS.filter((m) => !m.hidden);
  let disabledModels: string[] = [];
  try {
    disabledModels = JSON.parse(value("atomikEngines") || "[]");
  } catch {}
  if (!Array.isArray(disabledModels)) disabledModels = [];
  const rateOf = (id: string) => {
    const m = MODELS.find((m) => m.id === id);
    if (!m) return "";
    const resolution = m.resolutions.includes(
      m.kind === "image" ? "1K" : "1080p",
    )
      ? m.kind === "image"
        ? "1K"
        : "1080p"
      : m.resolutions[0];
    const seconds = m.durations.includes(5) ? 5 : (m.durations[0] ?? 5);
    const price =
      m.kind === "image"
        ? estimateImage(session.rates, id, resolution, 0)
        : estimateVideo(
            session.rates,
            id,
            resolution,
            seconds,
            estimateTokens(resolution, "16:9", seconds),
            costUsd,
            { audio: false },
          );
    return price == null
      ? "Quote before generation"
      : `${money.price(price)} / ${m.kind === "image" ? "still" : `${seconds}s`}`;
  };
  const select = (key: string, options: [string, string][], label: string) => (
    <select
      aria-label={label}
      disabled={!admin || busy}
      value={value(key)}
      onChange={(e) => edit(key, e.target.value)}
    >
      {options.map(([id, text]) => (
        <option key={id} value={id}>
          {text}
        </option>
      ))}
    </select>
  );
  return (
    <ManagementPage
      tab="workspace"
      title="Your workspace"
      description="Make room for the way your team works."
      workspace={me?.workspace?.name ?? session.workspace?.name}
      actions={
        <Link className="management-button" href="/billing?workspace=new">
          <Building2 size={14} />
          New workspace
        </Link>
      }
    >
      {!session.signedIn ? (
        <ManagementCard>
          <div className="management-empty">
            <h2>Sign in to your workspace</h2>
            <p>Your settings are available after you sign in.</p>
            <Link
              className="management-button primary"
              href="/login?next=/settings"
            >
              Sign in
            </Link>
          </div>
        </ManagementCard>
      ) : (
        <>
          {(error || meError || settingsError) && (
            <ManagementNotice error>
              {error || meError || settingsError}
              <button
                className="management-button small"
                onClick={() => {
                  void refresh();
                  void refreshMe();
                }}
              >
                Retry
              </button>
            </ManagementNotice>
          )}
          {notice && <ManagementNotice>{notice}</ManagementNotice>}
          {!me || !settings ? (
            <ManagementNotice>Loading workspace settings…</ManagementNotice>
          ) : (
            <>
              <div className="management-toolbar">
                <div
                  className="management-tabs"
                  aria-label="Workspace settings"
                >
                  {tabs.filter(([id]) => id !== "activity" || owner || admin).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={tab === id}
                      onClick={() => setTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {(dirty || nameChanged) && (
                  <span className="management-badge">Unsaved changes</span>
                )}
              </div>
              <div className="management-split">
                <div className="management-stack">
                  {tab === "activity" && (owner || admin) && session.requestScope && <WorkspaceAudit key={session.requestScope} scope={session.requestScope} />}
                  {tab === "activity" && !owner && !admin && <ManagementNotice>Workspace activity is available to owners and admins.</ManagementNotice>}
                  {tab === "general" && (
                    <ManagementCard
                      title="Workspace identity"
                      description="The name your team sees across Particl."
                    >
                      <form
                        className="management-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void save();
                        }}
                      >
                        <div className="management-identity">
                          <div className="management-avatar">
                            <Building2 size={19} />
                          </div>
                          <div>
                            <strong>{me.workspace?.name}</strong>
                            <small>
                              Private workspace · {owner ? "Owner" : me.role}
                            </small>
                          </div>
                        </div>
                        <label className="management-field">
                          <span>Workspace name</span>
                          <input
                            maxLength={80}
                            required
                            aria-label="Workspace name"
                            value={workspaceName}
                            disabled={!owner || busy}
                            onChange={(e) => setNameDraft(e.target.value)}
                          />
                          <small>
                            {owner
                              ? "Up to 80 characters. This does not change your saved projects."
                              : "The workspace owner can change its name."}
                          </small>
                        </label>
                        <div className="management-form-footer">
                          <span>Shared with everyone in this workspace.</span>
                          <button
                            className="management-button primary"
                            disabled={
                              busy || !nameChanged || !workspaceName.trim()
                            }
                          >
                            {busy ? "Saving…" : "Save name"}
                          </button>
                        </div>
                      </form>
                    </ManagementCard>
                  )}
                  {tab === "defaults" && (
                    <ManagementCard
                      title="Production defaults"
                      description="A consistent starting point for every new take."
                    >
                      <Row label="Default video model">
                        {select(
                          "defaultVideoModel",
                          [
                            ["", "Use platform default"],
                            ...models
                              .filter(
                                (m) =>
                                  m.kind === "video" &&
                                  m.durations.length > 0 &&
                                  (!m.supportsTasks ||
                                    m.supportsTasks.includes("generate")),
                              )
                              .map((m) => [m.id, m.label] as [string, string]),
                          ],
                          "Default video model",
                        )}
                      </Row>
                      <Row label="Default image model">
                        {select(
                          "defaultImageModel",
                          [
                            ["", "Use platform default"],
                            ...models
                              .filter((m) => m.kind === "image")
                              .map((m) => [m.id, m.label] as [string, string]),
                          ],
                          "Default image model",
                        )}
                      </Row>
                      <Row
                        label="Take approvals"
                        description="Control who can approve a finished take."
                      >
                        {select(
                          "approvalRule",
                          [
                            ["anyone", "Anyone"],
                            ["cap", "Anyone under the shot cap"],
                            ["producer", "Producer"],
                          ],
                          "Take approvals",
                        )}
                      </Row>
                      <Row
                        label="Shot credit cap"
                        description="The limit used by the shot approval rule."
                      >
                        <label className="management-field">
                          <input
                            aria-label="Shot credit cap"
                            type="number"
                            min="0"
                            step="1"
                            value={value("shotCapCredits")}
                            onChange={(e) =>
                              edit("shotCapCredits", e.target.value)
                            }
                            disabled={!admin || busy}
                          />
                        </label>
                      </Row>
                      <Row label="Warn at">
                        {select(
                          "capWarnPct",
                          [50, 70, 80, 90].map((n) => [
                            String(n),
                            `${n}% of the cap`,
                          ]),
                          "Warn at",
                        )}
                      </Row>
                      <Row label="At the project cap">
                        {select(
                          "atCap",
                          [
                            ["producer", "Producer unlocks"],
                            ["stop", "Stop rendering"],
                            ["warn", "Warn only"],
                          ],
                          "At the project cap",
                        )}
                      </Row>
                    </ManagementCard>
                  )}
                  {tab === "engines" && (
                    <>
                      {owner && <OpenAIConnection key={`openai:${session.requestScope}`} />}
                      {owner && <HiggsfieldConnection key={session.requestScope} />}
                      {owner && <HiggsfieldConsumerConnection key={`consumer:${session.requestScope}`} />}
                      <ManagementCard
                        title="Available engines"
                        description="Choose which models Atomik may recommend. Every paid request still needs your approval."
                      >
                        {models.map((m) => (
                          <Row
                            key={m.id}
                            label={m.label}
                            description={`${rateOf(m.id)} · ${engines?.engines.some((e) => e.configured && e.models.some((model) => model.id === m.id)) ? "Connected" : "Not connected"}`}
                          >
                            <Switch
                              label={`Atomik may propose ${m.label}`}
                              on={!disabledModels.includes(m.id)}
                              disabled={!admin || busy}
                              onChange={(on) =>
                                edit(
                                  "atomikEngines",
                                  JSON.stringify(
                                    on
                                      ? disabledModels.filter(
                                          (id) => id !== m.id,
                                        )
                                      : [...disabledModels, m.id],
                                  ),
                                )
                              }
                            />
                          </Row>
                        ))}
                      </ManagementCard>
                      <ManagementCard title="Atomik planning">
                        <Row
                          label="Paid steps"
                          description="Review the model, references and total before starting."
                        >
                          <span className="management-badge">
                            Always confirmed
                          </span>
                        </Row>
                        {!money.inCredits && (
                          <Row label="Automatic prompt writer">
                            {select(
                              "promptWriter",
                              [
                                ["claude", "Claude"],
                                ["byteplus", "Engine writer"],
                                ["none", "None"],
                              ],
                              "Automatic prompt writer",
                            )}
                          </Row>
                        )}
                        {/* /workbench switches to the Studio home now; Atomik has its own suite. */}
                        <Link className="management-link" href="/suites?suite=atomik&page=agent">
                          Open Atomik <ArrowUpRight size={13} />
                        </Link>
                      </ManagementCard>
                    </>
                  )}
                  {tab === "storage" && (
                    <>
                      <ManagementCard
                        title="Files & delivery"
                        description="Keep originals intact and make exports easy to identify."
                      >
                        <label className="management-field">
                          <span>Filename pattern</span>
                          <input
                            disabled={!admin || busy}
                            value={value("namingTemplate")}
                            onChange={(e) =>
                              edit("namingTemplate", e.target.value)
                            }
                            spellCheck={false}
                          />
                          <small>
                            {
                              "{project} · {scene} · {shot} · {model} · {version} · {user}"
                            }
                          </small>
                        </label>
                        <div style={{ marginTop: 18 }}>
                          <Row
                            label="Delivery copies"
                            description="Create a compatible copy when an API cannot accept the master."
                          >
                            <Switch
                              label="Delivery copies"
                              on={value("deriveForApi") !== "0"}
                              onChange={(on) =>
                                edit("deriveForApi", on ? "1" : "0")
                              }
                              disabled={!admin || busy}
                            />
                          </Row>
                          <Row label="Edit & extend format">
                            {select(
                              "editOutputFormat",
                              [
                                ["mp4", "MP4"],
                                ["mov", "MOV"],
                              ],
                              "Edit and extend format",
                            )}
                          </Row>
                          <Row
                            label="Deleted media retention"
                            description="Deleted and trashed work is hidden, never erased. It stays on the server indefinitely and can be restored."
                          >
                            <span>Kept indefinitely</span>
                          </Row>
                        </div>
                        <Link className="management-link" href="/platform">
                          How files, vendors and access are handled <ArrowUpRight size={13} />
                        </Link>
                      </ManagementCard>
                      <ManagementCard title="Asset controls">
                        <Row
                          label="Lock new assets"
                          description="New identities, voices and looks start locked."
                        >
                          <Switch
                            label="Lock new assets"
                            on={value("lockNewAssets") === "1"}
                            onChange={(on) =>
                              edit("lockNewAssets", on ? "1" : "0")
                            }
                            disabled={!admin || busy}
                          />
                        </Row>
                        <Row label="Training preference">
                          {select(
                            "trainOnCreate",
                            [
                              ["ask", "Ask each time"],
                              ["always", "Always"],
                              ["never", "Never"],
                            ],
                            "Training preference",
                          )}
                        </Row>
                        <p className="management-muted">
                          Training shows its price and requires confirmation
                          before a paid request.
                        </p>
                      </ManagementCard>
                    </>
                  )}
                  {tab === "notifications" && (
                    <ManagementCard
                      title="Notifications"
                      description="Choose the updates you want to receive."
                    >
                      {NOTIFY_KINDS.filter(
                        (k) => !NOTIFY_LABELS[k].adminOnly || admin,
                      ).map((k) => (
                        <Row key={k} label={NOTIFY_LABELS[k].title}>
                          <Switch
                            label={NOTIFY_LABELS[k].title}
                            on={notify?.prefs[k] ?? true}
                            onChange={(on) => void setNotify(k, on)}
                            disabled={busy}
                          />
                        </Row>
                      ))}
                      <PushRow />
                    </ManagementCard>
                  )}
                  {tab === "account" && (
                    <>
                      <ManagementCard
                        title="Your account"
                        description="Your sign-in is shared across the workspaces you belong to."
                      >
                        <div className="management-identity">
                          <div className="management-avatar">
                            {me.name.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <strong>{me.name}</strong>
                            <small>{me.email}</small>
                          </div>
                        </div>
                        <div style={{ marginTop: 22 }}>
                          <Row label="Workspace access">
                            <span className="management-badge">
                              {owner ? "Owner" : me.role}
                            </span>
                          </Row>
                          <Row label="Signed in as">
                            <span className="management-muted">{me.email}</span>
                          </Row>
                        </div>
                        <button
                          className="management-button"
                          style={{ marginTop: 22 }}
                          disabled={busy}
                          onClick={() => void signOut()}
                        >
                          Sign out
                        </button>
                      </ManagementCard>
                      <ManagementCard title="Account security" description="Manage two-step sign-in, recovery codes and your signed-in sessions across every workspace.">
                        <Link href="/account/security" className="management-button">Manage account security <ShieldCheck size={14}/></Link>
                      </ManagementCard>
                      {owner && (
                        <ManagementCard
                          title="Export workspace data"
                          description="Download the workspace records you are allowed to access."
                        >
                          <div className="management-actions">
                            <a
                              className="management-button"
                              download
                              href="/api/export?format=csv"
                            >
                              <Download size={14} />
                              Export CSV
                            </a>
                            <a
                              className="management-button"
                              download
                              href="/api/export"
                            >
                              <Download size={14} />
                              Export JSON
                            </a>
                          </div>
                        </ManagementCard>
                      )}
                      {owner && (
                        <ManagementCard
                          title="Delete workspace"
                          className="management-danger"
                        >
                          <p>
                            The team loses access immediately. Media and
                            workspace data are removed; billing records are
                            retained.
                          </p>
                          <button
                            className="management-button danger"
                            disabled={busy}
                            onClick={() => void deleteWorkspace()}
                          >
                            Delete workspace
                          </button>
                        </ManagementCard>
                      )}
                    </>
                  )}
                  {dirty && (
                    <div className="management-form-footer">
                      <span>Changes apply to this workspace.</span>
                      <button
                        className="management-button"
                        disabled={busy}
                        onClick={() => setDraft({})}
                      >
                        Discard changes
                      </button>
                      <button
                        className="management-button primary"
                        disabled={busy || !admin}
                        onClick={() => void save()}
                      >
                        {busy ? "Saving…" : "Save changes"}
                      </button>
                    </div>
                  )}
                </div>
                <aside className="management-stack">
                  <ManagementCard title="Made for your team">
                    <div className="management-row">
                      <div>
                        <ShieldCheck size={22} />
                        <p>
                          Projects, media and credits stay inside this
                          workspace.
                        </p>
                      </div>
                    </div>
                    <Link href="/team" className="management-button">
                      Manage people <ArrowUpRight size={13} />
                    </Link>
                  </ManagementCard>
                  <ManagementCard id="credits" title="Plans & credits">
                    <div className="management-credit-total">
                      {(me.credits ?? session.credits) ? (
                        <>
                          {(me.credits ??
                            session.credits)!.balance.toLocaleString()}{" "}
                          <small>cr available</small>
                        </>
                      ) : (
                        <small>Paid directly to your vendors</small>
                      )}
                    </div>
                    <Link className="management-button" href="/billing">
                      Manage credits <ArrowUpRight size={13} />
                    </Link>
                  </ManagementCard>
                  <ManagementCard title="Storage">
                    <strong className="management-amount">
                      {limits ? gb(limits.standing.usedBytes) : "—"}
                    </strong>
                    <p className="management-muted">
                      {limits
                        ? `of ${gb(limits.limits.storageBytes)} used`
                        : "Workspace media"}
                    </p>
                    {limits && (
                      <div className="management-progress">
                        <span
                          style={{
                            width: `${Math.min(100, (100 * limits.standing.usedBytes) / Math.max(1, limits.limits.storageBytes))}%`,
                          }}
                        />
                      </div>
                    )}
                  </ManagementCard>
                </aside>
              </div>
            </>
          )}
        </>
      )}
    </ManagementPage>
  );
}

/** Push on this device — a switch, or the one-line reason it can't be. */
function PushRow() {
  const scopedFetch = useScopedFetch();
  type PushState =
    | "off"
    | "on"
    | "busy"
    | "denied"
    | "install"
    | "unconfigured"
    | "unsupported";
  const [state, setState] = useState<PushState>("off");
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(async () => {
      if (!("serviceWorker" in navigator && "PushManager" in window)) {
        const ios =
          /iP(hone|ad|od)/.test(navigator.userAgent) &&
          !matchMedia("(display-mode: standalone)").matches;
        if (alive) setState(ios ? "install" : "unsupported");
        return;
      }
      if (!PUSH_KEY) {
        if (alive) setState("unconfigured");
        return;
      }
      if (Notification.permission === "denied") {
        if (alive) setState("denied");
        return;
      }
      const reg = await navigator.serviceWorker
        .getRegistration()
        .catch(() => null);
      const on = Boolean(reg && (await reg.pushManager.getSubscription()));
      if (alive && on) setState("on");
    });
    return () => {
      alive = false;
    };
  }, []);
  async function enable() {
    setState("busy");
    try {
      if (!PUSH_KEY) throw new Error("The push keys aren't in this build yet.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(PUSH_KEY),
      });
      const res = await scopedFetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => ({}))).error ??
            "The server rejected it.",
        );
      setState("on");
    } catch (e) {
      appAlert("Couldn't turn on notifications", (e as Error).message);
      setState(PUSH_KEY ? "off" : "unconfigured");
    }
  }
  async function disable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        const response = await scopedFetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        if (!response.ok)
          throw new Error((await response.json().catch(() => ({}))).error || "Notification settings could not be changed.");
        await sub.unsubscribe();
      }
      setState("off");
    } catch (e) {
      setState("on");
      await appAlert("Notifications are still on", (e as Error).message);
    }
  }
  if (state === "unsupported") return null;
  const note =
    state === "denied"
      ? "blocked in the browser"
      : state === "install"
        ? "add to the Home Screen first"
        : state === "unconfigured"
          ? "not set up here"
          : null;
  return (
    <Row
      label={
        <span className="flex flex-col gap-[3px]">
          Push on this device
          {note && <small className="management-muted">{note}</small>}
        </span>
      }
      gap
    >
      {note ? (
        <span className="management-muted">Unavailable</span>
      ) : (
        <Switch
          on={state === "on"}
          label="Push on this device"
          disabled={state === "busy"}
          onChange={(v) => (v ? enable() : disable())}
        />
      )}
    </Row>
  );
}
