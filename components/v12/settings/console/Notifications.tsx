"use client";
import { useState } from "react";
import { NOTIFY_KINDS, NOTIFY_LABELS, type NotifyKind } from "@/lib/notifyPrefs";
import { useRead, useWrite } from "@/components/graphite/settings/use-settings";
import { Note, Problem, Sec, Switch } from "./parts";

/** Settings › Notifications: what Particl tells you about, each one yours alone (GET and PATCH /api/me/notify). A member is not offered the admin-only ones. */
export function Notifications({ admin }: { admin: boolean }) {
  const write = useWrite();
  const { data, error, read } = useRead<{ prefs: Record<NotifyKind, boolean> }>("/api/me/notify");
  const [busy, setBusy] = useState<NotifyKind | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = async (kind: NotifyKind, on: boolean) => {
    setBusy(kind); setNote(null);
    const { error: refused } = await write("/api/me/notify", "PATCH", { kind, on });
    setBusy(null);
    if (refused) { setNote(refused); return; }
    await read();
  };
  return (
    <Sec testId="v12-settings-notifications">
      {error ? <Problem text={error} onRetry={() => void read()} /> : null}
      {NOTIFY_KINDS.filter((k) => admin || !NOTIFY_LABELS[k].adminOnly).map((kind) => {
        const on = data?.prefs[kind] ?? true;
        return <Switch key={kind} on={on} disabled={!data || busy != null} name={NOTIFY_LABELS[kind].title} state={on ? "On" : "Off"} line={NOTIFY_LABELS[kind].line} onChange={(next) => void set(kind, next)} testId={`v12-settings-notify-${kind}`} />;
      })}
      {note ? <Note ok={false} text={note} /> : null}
    </Sec>
  );
}
