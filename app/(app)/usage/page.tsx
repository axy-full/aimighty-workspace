"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Download,
  Image as ImageIcon,
  Film,
  AudioLines,
  Sparkles,
} from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useMoney } from "@/lib/price";
import { usePageTitle } from "@/lib/usePageTitle";
import { usd, timeAgo } from "@/lib/format";
import { appConfirm } from "@/components/dialog";
import type { Analytics } from "@/components/Analytics";
import type { Gen } from "@/components/GenCard";
import { stateOf } from "@/components/Feed";
import ManagementPage, {
  ManagementCard,
  ManagementNotice,
  ManagementStat,
} from "@/components/management/ManagementPage";
const gb = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;
type Vendor = {
  id: string;
  label: string;
  serves: string;
  via: string | null;
  configured: boolean;
  envKey: string;
  added: number;
  spent: number;
  renderSpend: number;
  promptSpend: number;
  remaining: number;
  unit: "usd" | "credits";
  addedCredits: number;
  spentCredits: number;
  remainingCredits: number;
  usdPerCredit: number | null;
  renders: number;
  attempts: number;
  prompts: number;
  tokens: number;
  live:
    | { kind: "gateway"; balanceUsd: number; usedUsd: number }
    | {
        kind: "credits";
        used: number;
        limit: number;
        tier: string;
        resetAt: number | null;
      }
    | null;
  note: string;
  /** What we would have said with no reading to anchor to. */
  computedSpent: number;
  computedCredits: number;
  /** The most recent reading from this vendor's own console. */
  anchor: {
    checkedAt: number;
    balanceUsd: number | null;
    spendUsd: number | null;
    balanceCredits: number | null;
    spendCredits: number | null;
    note: string;
    authorName: string | null;
    sinceUsd: number;
    sinceCredits: number;
    sinceRenders: number;
    driftUsd: number | null;
    driftCredits: number | null;
  } | null;
  models: {
    model: string;
    label: string;
    n: number;
    spend: number;
    credits?: number;
    tokens: number;
  }[];
  topups: {
    id: string;
    amountUsd: number;
    credits: number | null;
    note: string;
    createdAt: number;
  }[];
};

type Usage = {
  purchasedUsd: number;
  spentUsd: number;
  spentCredits?: number;
  remainingUsd: number;
  totalGenerations: number;
  succeeded: number;
  failed: number;
  pending: number;
  totalTokens: number;
  avgCostUsd: number;
  promptSpendUsd: number;
  promptCount: number;
  vendors: Vendor[];
  /** Rent rather than a purchase: what it costs to KEEP what has been made. */
  storage: {
    bytes: number;
    counted: number;
    unmeasured: number;
    monthlyUsd: number;
    yearlyUsd: number;
    byKind: { kind: string; n: number; bytes: number; monthlyUsd: number }[];
    largest: {
      id: string;
      title: string | null;
      kind: string;
      bytes: number;
    }[];
    perGbMonthUsd: number;
    perGbTransferUsd: number;
  } | null;
  byProject: { name: string; n: number; spend: number; credits?: number }[];
  byPerson: { name: string; n: number; spend: number; credits?: number }[];
  timing: {
    kind: string;
    n: number;
    totalMs: number | null;
    queueMs: number | null;
    refineMs: number | null;
    submitMs: number | null;
    engineMs: number | null;
    noticeMs: number | null;
    storeMs: number | null;
  }[];
  refines: {
    model: string;
    label: string;
    n: number;
    inTokens: number;
    outTokens: number;
    tokens: number;
    spend: number;
    free: boolean;
    freeLeft: number;
  }[];
  byMonth: { month: string; n: number; spend: number; credits?: number }[];
  recent: {
    id: string;
    label: string;
    provider: string;
    kind: string;
    title: string | null;
    prompt: string;
    costUsd: number;
    credits?: number;
    renderCostUsd: number;
    refineCostUsd: number | null;
    refineModel: string | null;
    refineLabel: string | null;
    refineInTokens: number | null;
    refineOutTokens: number | null;
    totalTokens: number;
    params: Record<string, unknown>;
    createdAt: number;
  }[];
};

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows
    .map((row) =>
      row
        .map((value) => {
          const s = String(value);
          const safe =
            typeof value === "string" && /^[=+@-]/.test(s) ? "'" + s : s;
          return `"${safe.replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function UsagePage() {
  const session = useSession();
  return <UsageContent key={`${session.workspace?.id}:${session.email}`} />;
}
function UsageContent() {
  usePageTitle("Usage");
  const session = useSession(),
    money = useMoney();
  const { data, error, refresh } = useApi<Usage>("/api/usage", 30000);
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [open, setOpen] = useState<string | null>(null),
    [tab, setTab] = useState("overview");
  const recent = (data?.recent ?? []).filter(
    (row) =>
      (filter === "all" || row.provider === filter) &&
      `${row.title || ""} ${row.prompt} ${row.label}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function exportCsv() {
    if (!data) return;
    downloadCsv("particl-usage.csv", [
      [
        "Date",
        "Action",
        "Engine",
        money.inCredits ? "Credits" : "USD",
        "Prompt",
      ],
      ...recent.map((row) => [
        new Date(row.createdAt).toISOString(),
        row.title || row.kind,
        row.label,
        money.inCredits ? (row.credits ?? 0) : row.costUsd,
        row.prompt,
      ]),
    ]);
  }
  return (
    <ManagementPage
      tab="usage"
      title="Know what goes into it."
      description="Your workspace activity, production spend and generation history."
      workspace={session.workspace?.name}
      actions={
        <button
          className="management-button"
          disabled={!data}
          onClick={exportCsv}
        >
          <Download size={14} />
          Export CSV
        </button>
      }
    >
      {error && (
        <ManagementNotice error>
          {error}
          <button
            className="management-button small"
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </ManagementNotice>
      )}
      {!data && !error && (
        <ManagementNotice>
          {session.signedIn
            ? "Reading workspace usage…"
            : "Sign in to see your workspace activity."}
        </ManagementNotice>
      )}
      {data && (
        <>
          <div className="management-grid four">
            <ManagementStat
              label={
                money.inCredits
                  ? "Credits used · all time"
                  : "Recorded spend · all time"
              }
              value={money.of({
                spend: data.spentUsd,
                credits: data.spentCredits,
              })}
              note="Includes billed and reserved work"
            />
            <ManagementStat
              label="Completed generations"
              value={data.succeeded.toLocaleString()}
              note={`${data.totalGenerations.toLocaleString()} total attempts`}
            />
            <ManagementStat
              label="Active jobs"
              value={data.pending.toLocaleString()}
              note={`${data.failed.toLocaleString()} failed attempts`}
            />
            <ManagementStat
              label="Available balance"
              value={
                session.credits
                  ? `${session.credits.balance.toLocaleString()} cr`
                  : "Direct"
              }
              note={
                session.credits
                  ? "Shared workspace credits"
                  : "Billed through connected providers"
              }
            />
          </div>
          <div className="management-tabs" aria-label="Usage views">
            <button
              aria-pressed={tab === "overview"}
              onClick={() => setTab("overview")}
            >
              Overview
            </button>
            <button
              aria-pressed={tab === "production"}
              onClick={() => setTab("production")}
            >
              Production detail
            </button>
            {!money.inCredits && (
              <button
                aria-pressed={tab === "engines"}
                onClick={() => setTab("engines")}
              >
                Engine balances
              </button>
            )}
          </div>
          {tab === "production" ? (
            <ProductionPerformance />
          ) : tab === "engines" && !money.inCredits ? (
            <div className="management-grid">
              {data.vendors.map((vendor) => (
                <VendorPanel key={vendor.id} v={vendor} onChanged={refresh} />
              ))}
            </div>
          ) : (
            <>
              <div className="management-grid three">
                <Breakdown title="By production" rows={data.byProject} />
                <Breakdown title="By person" rows={data.byPerson} />
                <Breakdown
                  title="By month"
                  rows={data.byMonth.map((row) => ({
                    ...row,
                    name: row.month,
                  }))}
                />
              </div>
              <ManagementCard>
                <div className="management-card-heading">
                  <div>
                    <h2>Activity ledger</h2>
                    <p>
                      Each paid attempt stays recorded, including deleted work.
                    </p>
                  </div>
                  <span className="management-badge">
                    {recent.length} shown
                  </span>
                </div>
                <div
                  className="management-toolbar"
                  style={{ marginBottom: 12 }}
                >
                  <label className="management-field management-search">
                    <span className="sr-only">Search activity</span>
                    <input
                      placeholder="Search your activity…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <label className="management-field">
                    <span className="sr-only">Filter by engine provider</span>
                    <select
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    >
                      <option value="all">All engine providers</option>
                      {data.vendors.map((vendor) => (
                        <option key={vendor.id} value={vendor.id}>
                          {vendor.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="management-list">
                  {recent.map((row) => {
                    const Icon =
                      row.kind === "image"
                        ? ImageIcon
                        : row.kind === "audio"
                          ? AudioLines
                          : row.kind === "video"
                            ? Film
                            : Sparkles;
                    return (
                      <div key={row.id} className="management-activity">
                        <button
                          aria-expanded={open === row.id}
                          onClick={() =>
                            setOpen(open === row.id ? null : row.id)
                          }
                        >
                          <span className="management-activity-icon">
                            <Icon size={15} />
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div className="management-activity-title">
                              {row.title || row.prompt || row.label}
                            </div>
                            <div className="management-activity-meta">
                              {row.label} · {timeAgo(row.createdAt)}
                            </div>
                          </div>
                          <span className="management-amount">
                            {money.of({
                              spend: row.costUsd,
                              credits: row.credits,
                            })}
                          </span>
                        </button>
                        {open === row.id && (
                          <div className="management-activity-detail">
                            <p>{row.prompt || "No prompt recorded."}</p>
                            <p>
                              {[
                                row.kind,
                                (row.params as { resolution?: string })
                                  .resolution,
                                (row.params as { ratio?: string }).ratio,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                            <small>
                              {new Date(row.createdAt).toLocaleString()} ·{" "}
                              {row.id}
                            </small>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!recent.length && (
                    <div className="management-empty">
                      <Activity size={26} style={{ margin: "0 auto 14px" }} />
                      <h2>
                        {search || filter !== "all"
                          ? "No matching activity"
                          : "Your activity will appear here"}
                      </h2>
                      <p>
                        {search || filter !== "all"
                          ? "Try another engine or search term."
                          : "Start a production to create your first take."}
                      </p>
                    </div>
                  )}
                </div>
              </ManagementCard>
              {data.storage && (
                <ManagementCard
                  title="Media storage"
                  description="Originals and working assets retained in this workspace."
                >
                  <div className="management-grid three">
                    <ManagementStat
                      label="Stored media"
                      value={gb(data.storage.bytes)}
                    />
                    <ManagementStat
                      label="Measured files"
                      value={data.storage.counted}
                    />
                    <ManagementStat
                      label="Waiting to measure"
                      value={data.storage.unmeasured}
                    />
                  </div>
                  <Link
                    href="/settings"
                    className="management-link"
                    style={{ marginTop: 18 }}
                  >
                    Manage file preferences
                  </Link>
                </ManagementCard>
              )}
            </>
          )}
        </>
      )}
    </ManagementPage>
  );
}
function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; n: number; spend: number; credits?: number }[];
}) {
  const money = useMoney();
  const amount = (row: (typeof rows)[number]) =>
    money.inCredits ? (row.credits ?? 0) : row.spend;
  const ordered = rows.slice().sort((a, b) => amount(b) - amount(a)),
    max = Math.max(1, ...ordered.map(amount));
  return (
    <ManagementCard title={title}>
      {ordered.length ? (
        ordered.slice(0, 8).map((row, index) => (
          <div className="management-chart-row" key={`${row.name}:${index}`}>
            <div>
              <span>{row.name}</span>
              <span className="management-amount">{money.of(row)}</span>
            </div>
            <div className="management-progress">
              <span
                style={{ width: `${Math.max(0, (amount(row) / max) * 100)}%` }}
              />
            </div>
            <small>{row.n} recorded attempts</small>
          </div>
        ))
      ) : (
        <p className="management-muted">No activity recorded yet.</p>
      )}
    </ManagementCard>
  );
}
function VendorPanel({ v, onChanged }: { v: Vendor; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [balance, setBalance] = useState("");
  const [portalSpend, setPortalSpend] = useState("");

  /** Write down what the vendor's own console says, and anchor to it. */
  async function saveCheck() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/ledger-checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: v.id,
          // Recorded in whatever unit the console showed, never converted:
          // converting at read time would bake in whatever rate we happened
          // to believe on the day.
          ...(v.unit === "credits"
            ? {
                balanceCredits: balance.trim() === "" ? null : Number(balance),
                spendCredits:
                  portalSpend.trim() === "" ? null : Number(portalSpend),
              }
            : {
                balanceUsd: balance.trim() === "" ? null : Number(balance),
                spendUsd:
                  portalSpend.trim() === "" ? null : Number(portalSpend),
              }),
          note: note.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not record it");
      setBalance("");
      setPortalSpend("");
      setNote("");
      setChecking(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/topups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          v.unit === "credits"
            ? { credits: n, amountUsd: 0, note, provider: v.id }
            : { amountUsd: n, note, provider: v.id },
        ),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not record it");
      setAmount("");
      setNote("");
      setAdding(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Removing a top-up rewrites what this vendor's ledger says is left, so
   * it asks — the number people read to decide whether they can afford a
   * render moves the moment this runs.
   */
  async function remove(t: Vendor["topups"][number]) {
    const amount =
      t.credits != null
        ? `${cr(t.credits)} credits${t.amountUsd ? ` · ${usd(t.amountUsd, 2)}` : ""}`
        : usd(t.amountUsd, 2);
    const ok = await appConfirm(
      `Remove this top-up of ${amount}?`,
      "The balance on this ledger drops by that much. Spending already recorded stays as it is.",
      { confirmLabel: "Remove", danger: true },
    );
    if (!ok) return;
    const res = await fetch(`/api/topups?id=${encodeURIComponent(t.id)}`, {
      method: "DELETE",
    });
    if (res.ok) onChanged();
  }

  const session = useSession(),
    admin = session.role === "owner" || session.role === "admin";
  const credits = v.unit === "credits",
    cr = (n: number) => n.toLocaleString();
  const format = (n: number) =>
    credits ? `${n.toLocaleString()} cr` : usd(n, 2);
  return (
    <ManagementCard
      title={v.label}
      description={v.serves}
      action={
        <span className={`management-badge ${v.configured ? "active" : ""}`}>
          {v.configured ? "Connected" : "Not connected"}
        </span>
      }
    >
      <div className="management-credit-total">
        {format(credits ? v.remainingCredits : v.remaining)}
      </div>
      <dl className="management-definition">
        <div>
          <dt>Added</dt>
          <dd>{format(credits ? v.addedCredits : v.added)}</dd>
        </div>
        <div>
          <dt>Recorded spend</dt>
          <dd>{format(credits ? v.spentCredits : v.spent)}</dd>
        </div>
      </dl>
      {v.live?.kind === "gateway" && (
        <p className="management-muted">
          Provider balance: {usd(v.live.balanceUsd, 2)}
        </p>
      )}
      {v.live?.kind === "credits" && (
        <p className="management-muted">
          Provider balance:{" "}
          {Math.max(0, v.live.limit - v.live.used).toLocaleString()} credits
        </p>
      )}
      {v.anchor && (
        <p className="management-muted">
          Last checked {timeAgo(v.anchor.checkedAt)}
          {v.anchor.authorName ? ` by ${v.anchor.authorName}` : ""}.
        </p>
      )}
      {admin && (
        <div className="management-actions" style={{ marginTop: 20 }}>
          <button
            className="management-button small"
            onClick={() => {
              setChecking(!checking);
              setAdding(false);
            }}
          >
            Record console balance
          </button>
          <button
            className="management-button small"
            onClick={() => {
              setAdding(!adding);
              setChecking(false);
            }}
          >
            Record a top-up
          </button>
        </div>
      )}
      {checking && (
        <form
          className="management-form"
          style={{ marginTop: 20 }}
          onSubmit={(event) => {
            event.preventDefault();
            void saveCheck();
          }}
        >
          <div className="management-grid">
            <label className="management-field">
              <span>Balance shown {credits ? "(credits)" : "(USD)"}</span>
              <input
                inputMode="decimal"
                value={balance}
                onChange={(event) => setBalance(event.target.value)}
              />
            </label>
            <label className="management-field">
              <span>Spend to date (optional)</span>
              <input
                inputMode="decimal"
                value={portalSpend}
                onChange={(event) => setPortalSpend(event.target.value)}
              />
            </label>
          </div>
          <label className="management-field">
            <span>Note</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="management-actions">
            <button
              className="management-button primary"
              disabled={busy || (!balance.trim() && !portalSpend.trim())}
            >
              {busy ? "Saving…" : "Save reading"}
            </button>
            <button
              type="button"
              className="management-button"
              onClick={() => setChecking(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {adding && (
        <form
          className="management-form"
          style={{ marginTop: 20 }}
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="management-field">
            <span>Amount {credits ? "(credits)" : "(USD)"}</span>
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="management-field">
            <span>Note or invoice reference</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p className="management-muted">
            This records a payment already made to the provider. It does not
            purchase credits.
          </p>
          <div className="management-actions">
            <button
              className="management-button primary"
              disabled={busy || !amount.trim()}
            >
              {busy ? "Recording…" : "Record payment"}
            </button>
            <button
              type="button"
              className="management-button"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {err && <ManagementNotice error>{err}</ManagementNotice>}
      {!!v.models.length && (
        <details style={{ marginTop: 22 }}>
          <summary>Model activity · {v.models.length}</summary>
          {v.models.map((model) => (
            <div className="management-row" key={model.model}>
              <div>
                <strong>{model.label}</strong>
                <p>{model.n} takes</p>
              </div>
              <span className="management-amount">{usd(model.spend, 2)}</span>
            </div>
          ))}
        </details>
      )}
      {!!v.topups.length && (
        <details style={{ marginTop: 16 }}>
          <summary>Recorded payments · {v.topups.length}</summary>
          {v.topups.map((topup) => (
            <div className="management-row" key={topup.id}>
              <div>
                <strong>
                  {topup.credits != null
                    ? `${cr(topup.credits)} credits`
                    : usd(topup.amountUsd, 2)}
                </strong>
                <p>
                  {topup.note || "Payment"} · {timeAgo(topup.createdAt)}
                </p>
              </div>
              {admin && (
                <button
                  className="management-button small danger"
                  onClick={() => void remove(topup)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </details>
      )}
    </ManagementCard>
  );
}

type Production = {
  id: string;
  name: string;
  spend: number;
  credits?: number;
  capUsd: number | null;
  capCredits?: number | null;
  shots: number;
  approvedShots: number;
};
function ProductionPerformance() {
  const money = useMoney();
  const [period, setPeriod] = useState("month"),
    [projectId, setProjectId] = useState("all");
  const days = period === "month" ? new Date().getDate() : Number(period);
  const { data: analytics, error } = useApi<Analytics>(
    `/api/analytics?days=${days}${projectId !== "all" ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
    30000,
  );
  const { data: projects } = useApi<{ projects: Production[] }>(
    "/api/projects",
    30000,
  );
  const { data: jobs } = useApi<{ generations: Gen[] }>(
    projectId !== "all"
      ? `/api/jobs?projectId=${encodeURIComponent(projectId)}&limit=500&sync=0`
      : null,
    30000,
  );
  const project = projects?.projects.find((row) => row.id === projectId);
  const shotRows = useMemo(() => {
    const groups = new Map<string, Gen[]>();
    for (const job of jobs?.generations ?? []) {
      if (!job.shotCode || job.kind === "image" || job.kind === "audio")
        continue;
      const group = groups.get(job.shotCode) ?? [];
      group.push(job);
      groups.set(job.shotCode, group);
    }
    return [...groups]
      .map(([code, takes]) => ({
        code,
        n: takes.length,
        paid: money.sum(takes),
        approved: takes.some((take) => stateOf(take) === "approved"),
        back: takes.filter((take) => take.reviewState === "changes").length,
      }))
      .sort((a, b) => b.n - a.n);
  }, [jobs, money]);
  const cap = project
      ? money.inCredits
        ? project.capCredits
        : project.capUsd
      : null,
    spent = project
      ? money.inCredits
        ? (project.credits ?? 0)
        : project.spend
      : 0,
    approved = project?.approvedShots ?? 0;
  const projected =
    approved && project ? (spent / approved) * project.shots : null;
  return (
    <>
      <ManagementCard>
        <div className="management-toolbar">
          <div>
            <h2>Production performance</h2>
            <p className="management-muted">
              Follow the takes, approvals and budget behind each production.
            </p>
          </div>
          <div className="management-actions">
            <label className="management-field">
              <span>Production</span>
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="all">All productions</option>
                {projects?.projects.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="management-field">
              <span>Period</span>
              <select
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
              >
                <option value="month">This month</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </select>
            </label>
          </div>
        </div>
      </ManagementCard>
      {error && <ManagementNotice error>{error}</ManagementNotice>}
      <div className="management-grid four">
        <ManagementStat
          label="Spend in this period"
          value={analytics ? money.of(analytics.totals) : "—"}
          note={`${analytics?.totals.generations ?? 0} takes`}
        />
        <ManagementStat
          label="Production budget"
          value={project ? money.of(project) : "—"}
          note={
            cap
              ? `${Math.round((spent / cap) * 100)}% of ${money.inCredits ? cap + " cr" : usd(cap, 0)} cap`
              : "No cap selected"
          }
        />
        <ManagementStat
          label="Cost per approved shot"
          value={project && approved ? money.each(project, approved) : "—"}
          note={
            project
              ? `${approved} of ${project.shots} shots approved`
              : "Select a production"
          }
        />
        <ManagementStat
          label="Projected total"
          value={
            projected != null
              ? money.inCredits
                ? Math.ceil(projected).toLocaleString() + " cr"
                : usd(projected, 2)
              : "—"
          }
          note="At the current cost per approval"
        />
      </div>
      <div className="management-grid">
        <Breakdown title="By production" rows={analytics?.byProject ?? []} />
        <Breakdown title="By person" rows={analytics?.byPerson ?? []} />
      </div>
      <ManagementCard
        title="Takes by shot"
        description="The most repeated shots appear first."
      >
        {!project ? (
          <p className="management-muted">
            Select a production to see its shots.
          </p>
        ) : !shotRows.length ? (
          <p className="management-muted">
            No video takes filed against a shot yet.
          </p>
        ) : (
          shotRows.map((shot) => (
            <div className="management-row" key={shot.code}>
              <div>
                <strong>{shot.code}</strong>
                <p>
                  {shot.n} takes · {shot.approved ? "Approved" : "In progress"}
                  {shot.back ? ` · ${shot.back} sent back` : ""}
                </p>
              </div>
              <span className="management-amount">{shot.paid}</span>
            </div>
          ))
        )}
      </ManagementCard>
    </>
  );
}
