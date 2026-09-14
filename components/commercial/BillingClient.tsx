"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { PlanDef } from "@/lib/plans";
import ManagementPage, {
  ManagementCard,
  ManagementNotice,
} from "@/components/management/ManagementPage";
import { ArrowUpRight, CreditCard, Plus } from "lucide-react";
import { formatUsd, type PlansResponse } from "./PricingClient";

type Topups = {
  applies: boolean;
  canRequest: boolean;
  provider: string;
  credits: { balance: number } | null;
  packs: {
    id: string;
    label: string;
    credits: number;
    bonus: number;
    total: number;
    usd: number;
  }[];
  requests: {
    id: string;
    label: string;
    credits: number;
    bonus: number;
    usd: number;
    status: string;
    createdAt: number;
  }[];
};

type Pending = {
  requestId: string;
  name: string;
  state: string;
  error: string | null;
};
type Workspaces = {
  active: string | null;
  workspaces: { id: string; name: string; role: string }[];
  pending?: Pending[];
  canCreate?: boolean;
  reason?: string;
};
type Billing = {
  annualDiscountPercent?: number;
  configured: boolean;
  reason?: string;
  canManage: boolean;
  workspace: { id: string; name: string };
  plans: PlanDef[];
  subscription: {
    planId: string;
    status: string;
    interval: "month" | "year";
    currentPeriodStart: number;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  } | null;
  credits: {
    balance: number;
    includedBalance: number;
    purchasedBalance: number;
    bonusBalance: number;
    otherBalance?: number;
    nextExpiryAt: number | null;
  } | null;
  invoiceUrl?: string;
};
const date = (value: number | null | undefined) =>
  value
    ? new Date(
        value < 10_000_000_000 ? value * 1000 : value,
      ).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
async function loadAccount(signal?: AbortSignal) {
  const responses = await Promise.all([
    fetch("/api/billing", { signal }),
    fetch("/api/workspaces", { signal }),
    fetch("/api/plans", { signal }),
    fetch("/api/workspaces/topups", { signal }),
  ]);
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );
  return { responses, bodies };
}
export default function BillingClient() {
  const router = useRouter(),
    query = useSearchParams(),
    initialPlan = query.get("plan"),
    initialCadence = query.get("cadence");
  const actionLock = useRef(false);
  const [topups, setTopups] = useState<Topups | null>(null);
  const [notice, setNotice] = useState("");
  const [data, setData] = useState<Billing | null>(null),
    [workspace, setWorkspace] = useState<Workspaces | null>(null),
    [plans, setPlans] = useState<PlansResponse | null>(null),
    [loading, setLoading] = useState(true),
    [signedOut, setSignedOut] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [newName, setNewName] = useState("");
  const [planId, setPlanId] = useState(
    ["studio", "agency", "production"].includes(initialPlan || "")
      ? initialPlan!
      : "studio",
  );
  const [cadence, setCadence] = useState<"monthly" | "annual">(
    initialCadence === "annual" ? "annual" : "monthly",
  );
  const applyAccount = useCallback(
    ({ responses, bodies }: Awaited<ReturnType<typeof loadAccount>>) => {
      const [billingResponse, workspaceResponse, plansResponse, topupResponse] =
        responses;
      setSignedOut(workspaceResponse.status === 401);
      const [billingBody, workspaceBody, plansBody, topupBody] = bodies;
      setTopups(
        topupResponse?.ok && Array.isArray(topupBody.packs) ? topupBody : null,
      );
      if (workspaceResponse.status === 401) {
        setWorkspace(null);
        setData(null);
        setLoading(false);
        return;
      }
      if (workspaceResponse.ok) setWorkspace(workspaceBody);
      if (billingResponse.ok) {
        setData(billingBody);
        setError("");
      } else if (workspaceResponse.ok && workspaceBody.active)
        setError(billingBody.error || "Billing details could not be loaded.");
      if (plansResponse.ok) setPlans(plansBody);
      setLoading(false);
    },
    [],
  );
  const refresh = () => loadAccount().then(applyAccount);
  useEffect(() => {
    const controller = new AbortController();
    loadAccount(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) applyAccount(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [applyAccount]);
  async function action(
    path: string,
    body: Record<string, unknown>,
    label: string,
  ) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(label);
    setError("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "This action could not be completed.");
      if (typeof result.url === "string") {
        const url = new URL(result.url, window.location.origin);
        if (url.protocol !== "https:" && url.origin !== window.location.origin)
          throw new Error("Checkout returned an unsupported address.");
        window.location.assign(url.href);
      } else {
        await refresh();
        if (path === "/api/workspaces" && result.workspace) {
          router.replace(`/billing?plan=${planId}&cadence=${cadence}`);
          router.refresh();
        }
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not reach billing. Try again.",
      );
    } finally {
      setBusy("");
      actionLock.current = false;
    }
  }
  const availablePlans = (data?.plans || plans?.plans || []).filter(
      (plan) => plan.id !== "invite",
    ),
    chosen = availablePlans.find((plan) => plan.id === planId),
    discount =
      data?.annualDiscountPercent ?? plans?.annualDiscountPercent ?? 20;
  const annualTotal = chosen
    ? Math.round(chosen.priceUsd * 12 * (1 - discount / 100) * 100) / 100
    : null;
  const monthly = chosen
    ? cadence === "annual"
      ? annualTotal! / 12
      : chosen.priceUsd
    : null;
  const status = data?.subscription?.status.replaceAll("_", " "),
    current = availablePlans.find(
      (plan) => plan.id === data?.subscription?.planId,
    );
  async function packAction(id: string, cancel = false) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        cancel
          ? `/api/workspaces/topups?id=${encodeURIComponent(id)}`
          : "/api/workspaces/topups",
        {
          method: cancel ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: cancel ? undefined : JSON.stringify({ packId: id }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error || "The credit request could not be completed.",
        );
      if (result.checkout?.url) {
        const url = new URL(result.checkout.url, window.location.origin);
        if (url.protocol !== "https:")
          throw new Error("Checkout returned an unsupported address.");
        window.location.assign(url.href);
        return;
      }
      setNotice(
        cancel
          ? "Credit request withdrawn."
          : "Credit pack requested. Your balance updates after the platform confirms payment.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      actionLock.current = false;
    }
  }
  const creditBalance = topups?.credits?.balance ?? data?.credits?.balance;
  const direct = topups?.applies === false;
  return (
    <ManagementPage
      tab="credits"
      title="Plans & credits"
      description="One balance for the whole team. Every generation priced before you start."
      workspace={data?.workspace.name}
      actions={
        <Link href="/usage" className="management-button">
          View usage <ArrowUpRight size={14} />
        </Link>
      }
    >
      {loading && <ManagementNotice>Loading your account…</ManagementNotice>}
      {error && (
        <ManagementNotice error>
          {error}
          <button
            className="management-button small"
            onClick={() =>
              void refresh().catch(() =>
                setError("Could not reload your account. Try again."),
              )
            }
          >
            Retry
          </button>
        </ManagementNotice>
      )}
      {notice && <ManagementNotice>{notice}</ManagementNotice>}
      {signedOut && (
        <ManagementCard>
          <div className="management-empty">
            <h2>Sign in to manage your workspace</h2>
            <p>Your selected plan will be waiting when you return.</p>
            <Link
              className="management-button primary"
              href={
                "/login?next=" +
                encodeURIComponent(`/billing?plan=${planId}&cadence=${cadence}`)
              }
            >
              Sign in
            </Link>
          </div>
        </ManagementCard>
      )}
      {!loading &&
        !signedOut &&
        workspace &&
        (!workspace.active || query.get("workspace") === "new") && (
          <ManagementCard
            title={
              workspace.pending?.length
                ? "Your workspace is being prepared"
                : "Create your studio workspace"
            }
            description="A private home for your productions. Creating a workspace does not start a subscription."
          >
            {workspace.pending?.map((pending) => (
              <div className="management-row" key={pending.requestId}>
                <div>
                  <strong>{pending.name}</strong>
                  <p>
                    {pending.state}
                    {pending.error ? ` · ${pending.error}` : ""}
                  </p>
                </div>
                <button
                  className="management-button"
                  disabled={!!busy}
                  onClick={() =>
                    void action(
                      "/api/workspaces",
                      { requestId: pending.requestId },
                      "workspace",
                    )
                  }
                >
                  {busy === "workspace" ? "Checking…" : "Retry workspace setup"}
                </button>
              </div>
            ))}
            {!workspace.pending?.length && (
              <form
                className="management-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(
                    "/api/workspaces",
                    { name: newName },
                    "workspace",
                  );
                }}
              >
                <label className="management-field">
                  <span>Workspace name</span>
                  <input
                    required
                    maxLength={80}
                    placeholder="Your production house"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    disabled={!!busy}
                  />
                </label>
                <div className="management-form-footer">
                  <span>
                    {workspace.reason ||
                      "Your existing workspace stays separate."}
                  </span>
                  <button
                    className="management-button primary"
                    disabled={!!busy || !workspace.canCreate || !newName.trim()}
                  >
                    <Plus size={14} />
                    {busy === "workspace" ? "Preparing…" : "Create workspace"}
                  </button>
                </div>
              </form>
            )}
          </ManagementCard>
        )}
      {data && (
        <>
          <div className="management-split">
            <ManagementCard
              title={direct ? "Your workspace billing" : "Available credits"}
              description={
                direct
                  ? "Your workspace pays its connected providers directly."
                  : "Shared by everyone in this workspace."
              }
              className="management-balance-card"
            >
              <div className="management-credit-total">
                {direct ? (
                  <small>Direct provider billing</small>
                ) : (
                  <>
                    {creditBalance?.toLocaleString() ?? "—"} <small>cr</small>
                  </>
                )}
              </div>
              {!direct && (
                <div className="management-grid three management-credit-breakdown">
                  <div>
                    <span className="management-muted">Included</span>
                    <p className="management-amount">
                      {data.credits?.includedBalance?.toLocaleString() ?? "0"}{" "}
                      cr
                    </p>
                  </div>
                  <div>
                    <span className="management-muted">Purchased</span>
                    <p className="management-amount">
                      {data.credits?.purchasedBalance?.toLocaleString() ?? "0"}{" "}
                      cr
                    </p>
                  </div>
                  <div>
                    <span className="management-muted">Bonus & other</span>
                    <p className="management-amount">
                      {(
                        (data.credits?.bonusBalance ?? 0) +
                        (data.credits?.otherBalance ?? 0)
                      ).toLocaleString()}{" "}
                      cr
                    </p>
                  </div>
                </div>
              )}
              <div className="management-row" style={{ marginTop: 20 }}>
                <div>
                  <p>
                    {direct
                      ? "Provider balances and recorded payments are in Usage."
                      : `Next credit expiry · ${date(data.credits?.nextExpiryAt)}`}
                  </p>
                </div>
                <Link
                  href={direct ? "/usage" : "#credit-packs"}
                  className="management-button"
                >
                  {direct ? "Engine balances" : "Add credits"}
                  <ArrowUpRight size={13} />
                </Link>
              </div>
            </ManagementCard>
            <ManagementCard
              title="Current plan"
              action={<CreditCard size={18} />}
            >
              <h3
                style={{
                  fontSize: 25,
                  letterSpacing: "-.03em",
                  margin: "0 0 6px",
                }}
              >
                {current?.label || "No paid subscription"}
              </h3>
              <p className="management-muted">
                {data.subscription
                  ? `${status}${data.subscription.cancelAtPeriodEnd ? " · Renewal canceled" : ""}`
                  : "Your saved work remains available."}
              </p>
              <dl className="management-definition" style={{ marginTop: 20 }}>
                <div>
                  <dt>Billing period</dt>
                  <dd>
                    {data.subscription
                      ? data.subscription.interval === "year"
                        ? "Annual"
                        : "Monthly"
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>
                    {data.subscription?.cancelAtPeriodEnd
                      ? "Access through"
                      : "Next renewal"}
                  </dt>
                  <dd>{date(data.subscription?.currentPeriodEnd)}</dd>
                </div>
              </dl>
              <button
                className="management-button"
                style={{ marginTop: 18 }}
                disabled={
                  !data.canManage ||
                  !data.configured ||
                  !data.subscription ||
                  !!busy
                }
                onClick={() => void action("/api/billing/portal", {}, "portal")}
              >
                {busy === "portal"
                  ? "Opening…"
                  : "Manage payments and invoices"}
              </button>
            </ManagementCard>
          </div>
          {!data.configured && (
            <ManagementNotice>
              <strong>Checkout is not available yet.</strong>{" "}
              {data.reason || "Online subscriptions are being connected."} No
              payment will be taken.
            </ManagementNotice>
          )}
          {!data.canManage && (
            <ManagementNotice>
              The workspace owner manages the subscription. Your team can view
              its balance and usage here.
            </ManagementNotice>
          )}
          <div className="management-toolbar">
            <div>
              <h2 className="management-section-title">
                A plan for your next production.
              </h2>
              <p className="management-muted">
                The same tools. More room to create. No seat fees on paid plans.
              </p>
            </div>
            <div className="management-actions">
              <label className="management-field">
                <span>Workspace plan</span>
                <select
                  aria-label="Workspace plan"
                  value={planId}
                  onChange={(e) => setPlanId(e.target.value)}
                >
                  {availablePlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="management-field">
                <span>Billing period</span>
                <select
                  aria-label="Billing period"
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value as typeof cadence)}
                >
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual · save {discount}%</option>
                </select>
              </label>
            </div>
          </div>
          <div className="management-grid three">
            {availablePlans.map((plan) => {
              const annual = plan.priceUsd * 12 * (1 - discount / 100);
              const price = cadence === "annual" ? annual / 12 : plan.priceUsd;
              return (
                <ManagementCard
                  key={plan.id}
                  className={`management-plan ${planId === plan.id ? "is-selected" : ""}`}
                >
                  <div className="management-toolbar">
                    <h3>{plan.label}</h3>
                    {planId === plan.id && (
                      <span className="management-badge">Selected</span>
                    )}
                  </div>
                  <div className="management-plan-price">
                    {formatUsd(price)} <small>/ month</small>
                  </div>
                  <strong className="management-amount">
                    {plan.includedCredits.toLocaleString()} credits / month
                  </strong>
                  <p>
                    {cadence === "annual"
                      ? `${formatUsd(annual)} billed annually`
                      : `${formatUsd(plan.priceUsd)} billed monthly`}
                  </p>
                  <p>Unlimited members · included credits renew monthly</p>
                  <button
                    aria-pressed={planId === plan.id}
                    className={`management-button ${planId === plan.id ? "primary" : ""}`}
                    onClick={() => setPlanId(plan.id)}
                  >
                    {planId === plan.id
                      ? "Selected plan"
                      : `Choose ${plan.label}`}
                  </button>
                </ManagementCard>
              );
            })}
          </div>
          <ManagementCard>
            <div className="management-toolbar">
              <div>
                <strong>
                  {chosen?.label || "Select a plan"}
                  {monthly != null
                    ? ` · ${cadence === "annual" ? formatUsd(annualTotal!) + " annually" : formatUsd(monthly) + " monthly"}`
                    : ""}
                </strong>
                <p className="management-muted">
                  Included credits expire at the end of each monthly credit
                  period. Your plan changes after payment is confirmed.
                </p>
              </div>
              <div className="management-actions">
                <Link
                  className="management-button"
                  href="/workbench?onboarding=1"
                >
                  Open your studio
                </Link>
                <button
                  className="management-button primary"
                  disabled={
                    !data.configured || !data.canManage || !chosen || !!busy
                  }
                  onClick={() =>
                    void action(
                      "/api/billing/checkout",
                      { planId, cadence },
                      "checkout",
                    )
                  }
                >
                  {busy === "checkout"
                    ? "Opening checkout…"
                    : data.subscription
                      ? "Review plan change"
                      : "Continue to secure checkout"}
                </button>
              </div>
            </div>
          </ManagementCard>
          {topups?.applies && (
            <>
              <div id="credit-packs">
                <h2 className="management-section-title">
                  More credits, when you need them.
                </h2>
                <p className="management-muted">
                  1 credit = US$0.10. Packs add to your workspace balance after
                  payment is confirmed.
                </p>
              </div>
              <div className="management-grid four">
                {topups.packs.map((pack) => (
                  <ManagementCard key={pack.id} className="management-plan">
                    <h3>{pack.label}</h3>
                    <div className="management-plan-price">
                      {formatUsd(pack.usd)}
                    </div>
                    <strong>{pack.total.toLocaleString()} cr</strong>
                    <p>
                      {pack.credits.toLocaleString()} purchased
                      {pack.bonus
                        ? ` + ${pack.bonus.toLocaleString()} bonus`
                        : ""}
                    </p>
                    <button
                      className="management-button"
                      disabled={!!busy || !topups.canRequest}
                      onClick={() => void packAction(pack.id)}
                    >
                      {busy === pack.id
                        ? "Requesting…"
                        : topups.provider === "manual"
                          ? "Request pack"
                          : "Buy credits"}
                    </button>
                  </ManagementCard>
                ))}
              </div>
              <p className="management-muted">
                Purchased credits last 12 months off a paid plan; their clock
                pauses during confirmed paid periods. Existing grants keep their
                original terms.
              </p>
              {!!topups.requests?.length && (
                <ManagementCard title="Credit requests">
                  {topups.requests.map((request) => (
                    <div className="management-row" key={request.id}>
                      <div>
                        <strong>
                          {request.label} ·{" "}
                          {(request.credits + request.bonus).toLocaleString()}{" "}
                          cr
                        </strong>
                        <p>
                          {formatUsd(request.usd)} · {request.status}
                        </p>
                      </div>
                      {request.status === "requested" && topups.canRequest && (
                        <button
                          className="management-button small"
                          disabled={!!busy}
                          onClick={() => void packAction(request.id, true)}
                        >
                          Withdraw request
                        </button>
                      )}
                    </div>
                  ))}
                </ManagementCard>
              )}
            </>
          )}
          <Link className="management-link" href="/terms">
            Subscription and credit terms <ArrowUpRight size={13} />
          </Link>
        </>
      )}
    </ManagementPage>
  );
}
