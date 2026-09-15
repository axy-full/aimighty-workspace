"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { PlanDef } from "@/lib/plans";
import CommercialLayout from "./CommercialLayout";

export type PlansResponse = {
  plans: PlanDef[];
  checkoutAvailable: boolean;
  reason?: string;
  annualDiscountPercent: number;
};
export const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 ? 2 : 0,
  }).format(value);
export default function PricingClient() {
  const [data, setData] = useState<PlansResponse | null>(null),
    [error, setError] = useState(""),
    [cadence, setCadence] = useState<"monthly" | "annual">("monthly");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/plans", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Plans could not be loaded.");
        setData(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  const discount = data?.annualDiscountPercent ?? 20;
  return (
    <CommercialLayout>
      <section className="commercial-intro">
        <span className="commercial-eyebrow">FOR PRODUCTION TEAMS</span>
        <h1>A workspace for the whole production.</h1>
        <p>
          Bring your brief, references, crew and takes into one place. Choose a
          monthly credit allowance for the work ahead.
        </p>
      </section>
      <div className="billing-cadence" role="group" aria-label="Billing period">
        <button
          aria-pressed={cadence === "monthly"}
          onClick={() => setCadence("monthly")}
        >
          Monthly
        </button>
        <button
          aria-pressed={cadence === "annual"}
          onClick={() => setCadence("annual")}
        >
          Annual <span>Save {discount}%</span>
        </button>
      </div>
      {error && (
        <p role="alert" className="commercial-notice">
          {error}{" "}
          <button onClick={() => window.location.reload()}>Try again</button>
        </p>
      )}
      {!data && !error && (
        <p role="status" className="commercial-notice">
          Loading current plans…
        </p>
      )}
      {data && !data.checkoutAvailable && (
        <div className="commercial-notice" role="status">
          <strong>Checkout is not available yet.</strong>
          <p>
            {data.reason ||
              "You can create and verify your account. Billing will be available when payments are connected."}
          </p>
          <p>No payment will be taken while checkout is unavailable.</p>
        </div>
      )}
      <div className="plan-grid">
        {data?.plans
          .filter((plan) => plan.id !== "invite")
          .map((plan) => {
            const yearly =
              Math.round(plan.priceUsd * 12 * (1 - discount / 100) * 100) / 100;
            const monthly = cadence === "annual" ? yearly / 12 : plan.priceUsd;
            return (
              <article className="plan-card" key={plan.id}>
                <span className="commercial-eyebrow">{plan.label}</span>
                <h2>
                  {formatUsd(monthly)}
                  <small>/ month</small>
                </h2>
                <p className="plan-billing">
                  {cadence === "annual"
                    ? `${formatUsd(yearly)} billed annually`
                    : "Billed monthly"}
                </p>
                <p className="plan-credits">
                  <strong>{plan.includedCredits.toLocaleString()}</strong>{" "}
                  credits every month
                </p>
                <ul>
                  <li>
                    {plan.maxMembers == null
                      ? "Your whole team · no seat fees"
                      : `Up to ${plan.maxMembers} members`}
                  </li>
                  <li>
                    {plan.maxProductions == null
                      ? "Unlimited projects"
                      : `Up to ${plan.maxProductions} projects`}
                  </li>
                  <li>Private workspace and shared production bibles</li>
                  <li>Image and video takes with version history</li>
                  <li>Source media and editorial packages</li>
                </ul>
                <Link
                  className="commercial-button primary"
                  href={`/signup?plan=${plan.id}&cadence=${cadence}`}
                >
                  Choose {plan.label}
                </Link>
              </article>
            );
          })}
      </div>
      <section className="commercial-details">
        <h2>Clear costs. Your work stays yours.</h2>
        <div>
          <article>
            <h3>Credits, quoted before you generate</h3>
            <p>
              The model, size and duration determine each take’s cost. Review
              the estimate before submitting. Uploads, planning and creative
              tools have their own applicable limits.
            </p>
          </article>
          <article>
            <h3>Annual billing, monthly credits</h3>
            <p>
              Annual plans are paid for a year at {discount}% less than twelve
              monthly payments. Included credits arrive monthly and expire at
              the end of each monthly credit period; they do not roll over.
            </p>
          </article>
          <article>
            <h3>A workspace subscription</h3>
            <p>
              Paid plans have no per-seat fee. The allowance is shared by your
              team. Additional credit packs are separate purchases. Provider and
              storage limits still apply.
            </p>
          </article>
          <article>
            <h3>Control your subscription</h3>
            <p>
              Review renewal, cancellation and payment details in Billing.
              Cancellation stops future renewal; it does not delete your
              production files. See the <Link href="/terms">terms</Link> for the
              full conditions.
            </p>
          </article>
        </div>
      </section>
    </CommercialLayout>
  );
}
