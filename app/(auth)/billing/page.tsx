import { Suspense } from "react";
import BillingClient from "@/components/commercial/BillingClient";
import "../../commercial.css";
export const metadata = { title: "Billing · Particl" };
export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className="commercial commercial-main">Loading billing…</div>
      }
    >
      <BillingClient />
    </Suspense>
  );
}
