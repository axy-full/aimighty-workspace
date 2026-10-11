"use client";
import { pushUnavailable, usePushSubscription } from "@/lib/push-client";
import type { BoardCtx } from "./cards/types";

/**
 * "Notify me when done" on a card whose work is running. Particl already tells a person on this device when a job they asked for
 * finishes (lib/jobs.ts → lib/push.ts); this button makes sure this device is one it tells, asking the browser's permission the
 * first time (lib/push-client.ts). It sends nothing and costs nothing.
 */
export function NotifyWhenDone({ ctx, className }: { ctx: BoardCtx; className?: string }) {
  const push = usePushSubscription();
  const press = async () => {
    const blocked = pushUnavailable(push.state);
    if (blocked) { ctx.toast(`Notifications on this device: ${blocked}.`); return; }
    if (push.state === "on") { ctx.toast("You'll be told on this device when it's done."); return; }
    if (push.state === "busy") return;
    const out = await push.enable();
    ctx.toast(out.ok ? "You'll be told on this device when it's done." : out.error);
  };
  return (
    <button type="button" className={`nodrag nopan${className ? ` ${className}` : ""}`} aria-pressed={push.state === "on"} disabled={push.state === "busy"}
      onClick={(e) => { e.stopPropagation(); void press(); }} onDoubleClick={(e) => e.stopPropagation()} data-testid="notify-when-done">
      Notify me when done
    </button>
  );
}
