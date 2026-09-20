import { deviceProbeScript } from "@/lib/workspace/device";
import { PHONE_QUERY } from "@/lib/workspace/switchover";

/**
 * The gate's device decision, taken while the document PARSES.
 *
 * Why here and not inside SwitchoverGate: the gate is a client component that
 * re-renders (pending → decided), and React never executes a <script> created
 * during a client render — it logs an error saying so, which is both noise and
 * a dev-overlay issue (`tests/customer.spec.ts` counts those). A server
 * component renders once, into the HTML, and is never re-rendered on the
 * client, which is exactly what a parse-time decision wants.
 *
 * Why parse time at all: taking the decision at first render means taking it at
 * hydration, and hydration is not a fixed point — a cold dev compile lands it
 * seconds after the document was readable, by which time a landscape phone's
 * keyboard may have closed and the height moved past `max-height: 500px`. The
 * gate would then redirect a phone into the desktop workspace mid-session. This
 * is also the instant switchover.css decides the first paint from the same
 * query, so the two halves of the gate cannot disagree.
 *
 * One constant string (PHONE_QUERY); nothing from the URL reaches it.
 */
export default function DeviceProbe() {
  return <script dangerouslySetInnerHTML={{ __html: deviceProbeScript(PHONE_QUERY) }} />;
}
