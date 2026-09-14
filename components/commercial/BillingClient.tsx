"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { PlanDef } from "@/lib/plans";
import CommercialLayout from "./CommercialLayout";
import { formatUsd, type PlansResponse } from "./PricingClient";

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
      const [billingResponse, workspaceResponse, plansResponse] = responses;
      setSignedOut(workspaceResponse.status === 401);
      const [billingBody, workspaceBody, plansBody] = bodies;
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
    if (busy) return;
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
  return (
    <CommercialLayout account={!signedOut}>
      <section className="commercial-intro">
        <span className="commercial-eyebrow">WORKSPACE BILLING</span>
        <h1>{data?.workspace.name || "Your studio account"}</h1>
        <p>Your plan, shared credits and payment details in one place.</p>
      </section>
      {loading && (
        <p role="status" className="commercial-notice">
          Loading your account…
        </p>
      )}
      {error && (
        <p role="alert" className="commercial-notice">
          {error}{" "}
          <button
            onClick={() =>
              void refresh().catch(() =>
                setError("Could not reload your account. Try again."),
              )
            }
          >
            Retry
          </button>
        </p>
      )}
      {signedOut && (
        <section className="billing-card billing-empty">
          <h2>Sign in to manage your workspace</h2>
          <p>Your selected plan will be waiting when you return.</p>
          <Link
            className="commercial-button primary"
            href={
              "/login?next=" +
              encodeURIComponent(`/billing?plan=${planId}&cadence=${cadence}`)
            }
          >
            Sign in
          </Link>
        </section>
      )}
      {!loading &&
        !signedOut &&
        workspace &&
        (!workspace.active || query.get("workspace") === "new") && (
          <section className="billing-card billing-empty">
            <h2>
              {workspace.pending?.length
                ? "Your workspace is being prepared"
                : "Create your studio workspace"}
            </h2>
            <p>
              Keep your account signed in while we prepare a private home for
              your productions. Choosing a name does not start a subscription.
            </p>
            {workspace.pending?.map((pending) => (
              <div key={pending.requestId} className="commercial-notice">
                <strong>{pending.name}</strong>
                <p>
                  {pending.state}
                  {pending.error ? ` · ${pending.error}` : ""}
                </p>
                <button
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
                className="billing-provision"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(
                    "/api/workspaces",
                    { name: newName },
                    "workspace",
                  );
                }}
              >
                <input
                  required
                  aria-label="Workspace name"
                  maxLength={100}
                  placeholder="Your production house"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <button
                  className="commercial-button primary"
                  disabled={!!busy || !workspace.canCreate || !newName.trim()}
                >
                  {busy === "workspace" ? "Preparing…" : "Create workspace"}
                </button>
              </form>
            )}
            {workspace.reason && (
              <p className="auth-status">{workspace.reason}</p>
            )}
          </section>
        )}
      {data && (
        <>
          <div className="billing-grid">
            <section className="billing-card">
              <span className="commercial-eyebrow">SUBSCRIPTION</span>
              <h2>{current?.label || "Choose a workspace plan"}</h2>
              <p>
                {data.subscription
                  ? `${status}${data.subscription.cancelAtPeriodEnd ? " · Renewal canceled" : ""}`
                  : "No paid subscription is active."}
              </p>
              <dl>
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
                <div>
                  <dt>Workspace</dt>
                  <dd>{data.workspace.name}</dd>
                </div>
              </dl>
              <div className="billing-actions">
                <button
                  className="commercial-button"
                  disabled={
                    !data.canManage ||
                    !data.configured ||
                    !data.subscription ||
                    !!busy
                  }
                  onClick={() =>
                    void action("/api/billing/portal", {}, "portal")
                  }
                >
                  {busy === "portal"
                    ? "Opening…"
                    : "Manage payments and invoices"}
                </button>
              </div>
              <p className="auth-status">
                Update your payment method, view invoices or cancel renewal in
                the billing portal.
              </p>
            </section>
            <section className="billing-card">
              <span className="commercial-eyebrow">
                SHARED WORKSPACE CREDITS
              </span>
              <p className="billing-credit-total">
                {data.credits ? data.credits.balance.toLocaleString() : "—"}{" "}
                <small>cr</small>
              </p>
              <dl>
                <div>
                  <dt>Monthly allowance remaining</dt>
                  <dd>
                    {data.credits?.includedBalance?.toLocaleString() ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt>Purchased credits remaining</dt>
                  <dd>
                    {data.credits?.purchasedBalance?.toLocaleString() ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt>Bonus credits remaining</dt>
                  <dd>{data.credits?.bonusBalance?.toLocaleString() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Next credit expiry</dt>
                  <dd>{date(data.credits?.nextExpiryAt)}</dd>
                </div>
              </dl>
              <div className="billing-actions">
                <Link className="commercial-button" href="/usage">
                  View usage
                </Link>
                <Link className="commercial-button" href="/settings#credits">
                  Credit packs
                </Link>
              </div>
            </section>
          </div>
          {!data.canManage && (
            <p role="status" className="commercial-notice">
              The workspace owner manages the subscription. Your team can view
              its balance and usage here.
            </p>
          )}
          {!data.configured && (
            <p role="status" className="commercial-notice">
              <strong>Checkout is not available yet.</strong>{" "}
              {data.reason ||
                "Payments are not connected for this deployment. Your account and saved work remain available."}{" "}
              No payment will be taken.
            </p>
          )}
          <section className="billing-card" style={{ marginTop: 24 }}>
            <h2>
              {data.subscription
                ? "Review another plan"
                : "Start a subscription"}
            </h2>
            <div className="billing-pick">
              <label>
                Workspace plan
                <select
                  aria-label="Workspace plan"
                  value={planId}
                  onChange={(event) => setPlanId(event.target.value)}
                >
                  {availablePlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.label} · {plan.includedCredits.toLocaleString()}{" "}
                      credits / month
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Billing period
                <select
                  aria-label="Billing period"
                  value={cadence}
                  onChange={(event) =>
                    setCadence(event.target.value as typeof cadence)
                  }
                >
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual · save {discount}%</option>
                </select>
              </label>
            </div>
            {chosen && monthly != null && (
              <p className="auth-status">
                {cadence === "annual"
                  ? `${formatUsd(annualTotal!)} paid annually (${formatUsd(monthly)} per month).`
                  : `${formatUsd(monthly)} billed monthly.`}{" "}
                {chosen.includedCredits.toLocaleString()} credits are granted
                each month and expire at the end of that monthly credit period.
              </p>
            )}
            <div className="billing-actions">
              <button
                className="commercial-button primary"
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
              <Link
                className="commercial-button"
                href="/workbench?onboarding=1"
              >
                Open your studio
              </Link>
            </div>
            <p className="auth-status">
              Review the final amount before confirming. Your plan changes after
              payment is confirmed.{" "}
              <Link href="/terms">Subscription terms</Link>
            </p>
          </section>
        </>
      )}
    </CommercialLayout>
  );
}
