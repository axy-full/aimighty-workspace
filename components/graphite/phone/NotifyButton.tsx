"use client";
import { pushUnavailable, usePushSubscription } from "@/lib/push-client";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * "Notify me" (README § 0 rule 9; U1 item 7). Particl already tells a person on their phone when a take they
 * asked for finishes (lib/jobs.ts → lib/push.ts, the "A take you asked for finished" choice, on by default).
 * This button makes sure this device is one it tells: it subscribes it, asking the browser's permission the
 * first time, through lib/push-client.ts. It sends nothing and costs nothing; no new kind of push.
 */
export function NotifyButton({ label = "Notify me", className = "ph-btn" }: { label?: string; className?: string }) {
  const push = usePushSubscription();
  const { toast } = useWorkspace();
  const press = async () => {
    const blocked = pushUnavailable(push.state);
    if (blocked) { toast(`Notifications on this phone: ${blocked}.`); return; }
    if (push.state === "on") { toast("You'll be told on this phone when it's done."); return; }
    if (push.state === "busy") return;
    const out = await push.enable();
    toast(out.ok ? "You'll be told on this phone when it's done." : out.error);
  };
  return (
    <button type="button" className={className} aria-pressed={push.state === "on"} disabled={push.state === "busy"} onClick={() => void press()} data-testid="phone-notify">
      {label}
    </button>
  );
}
