"use client";
import { DEFAULT_PLANS, type PlanDef } from "@/lib/plans";
import { Tooltip } from "../ui";
import { useAdminRead } from "./api";
import { Cr, Head } from "./parts";

/** What /api/admin/platform-layer answers: the layer as it stands, and its defaults. Plans are read from it, never typed here. */
type Layer = { layer: { plans: PlanDef[] } };

/** Plans & prices: the plan cards as customers see them, read only. Prices are set in config; checkout comes later. */
export function Plans() {
  const { data } = useAdminRead<Layer>("/api/admin/platform-layer", 0);
  const plans = data?.layer.plans ?? (data ? DEFAULT_PLANS : []);
  return (
    <>
      <Head title="Plans & prices" line="The plan cards as customers see them. Read only here." />
      <div className="v12-pc-toolbar v12-pc-between">
        <span className="v12-pc-meta">Checkout comes later</span>
        <Tooltip name="Edit prices" line="Prices are set in config — checkout comes later" side="left">
          <button type="button" className="v12-pc-btn" aria-disabled="true" data-testid="pc-edit-prices" onClick={(e) => e.preventDefault()}>Edit prices</button>
        </Tooltip>
      </div>
      <div className="v12-pc-plans" data-testid="pc-plans">
        {plans.map((p) => (
          <article key={p.id} className="v12-pc-plan" data-testid="pc-plan">
            <h2 className="v12-pc-plan-name">{p.label}</h2>
            <p className="v12-pc-plan-price"><strong>${p.priceUsd.toLocaleString("en-US")}</strong> <span className="v12-pc-meta">{p.priceUsd === 0 ? "to start" : "a month"}</span></p>
            <p className="v12-pc-plan-line">{p.includedCredits > 0 ? <><Cr credits={p.includedCredits} /> each month</> : "Welcome credits only"}</p>
            <p className="v12-pc-meta">{p.maxProductions === null ? "As many productions as you like" : `${p.maxProductions} production${p.maxProductions === 1 ? "" : "s"}`} · {p.maxMembers === null ? "unlimited people" : `${p.maxMembers} people`}</p>
          </article>
        ))}
      </div>
    </>
  );
}
