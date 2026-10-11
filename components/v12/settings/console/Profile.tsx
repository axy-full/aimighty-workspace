"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { signOut } from "@/lib/shell/sign-out";
import { avatarInitials, personLine, readableName } from "@/lib/shell/person";
import { useWorkspace } from "@/lib/workspace/state";
import { useWrite } from "@/components/graphite/settings/use-settings";
import { Note, Sec } from "./parts";

/**
 * Settings › Profile: your name (the account's, so it changes in every workspace you are in), your address, and Sign out. The
 * address changes only by the emailed flow, and there is no photo: your avatar is your initials.
 */
export function Profile() {
  const session = useSession();
  const write = useWrite();
  const scoped = useScopedFetch();
  const { toast } = useWorkspace();
  const saved = readableName(session.name) ?? "";
  const [name, setName] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const role = session.role === "owner" ? "Owner" : session.role === "admin" ? "Admin" : "Member";

  const save = async () => {
    setBusy(true); setNote(null);
    const { error } = await write("/api/me", "PATCH", { name: name.trim() });
    setBusy(false);
    if (error) { setNote({ ok: false, text: error }); return; }
    toast("Name saved.");
    window.location.reload();
  };
  return (
    <>
      <Sec testId="v12-settings-profile">
        <div className="v12-ws-id">
          <span className="v12-ws-av-lg" aria-hidden="true">{avatarInitials({ name: session.name }, session.workspace?.name)}</span>
          <span className="v12-ws-stack">
            <input className="v12-ws-field" value={name} maxLength={80} aria-label="Name" placeholder="Name" onChange={(e) => setName(e.target.value)} data-testid="v12-settings-profile-name" />
            <input className="v12-ws-field" value={session.email ?? ""} aria-label="Email" readOnly title="Your address changes by email." data-testid="v12-settings-profile-email" />
            <span><button type="button" className="v12-ws-btn v12-ws-btn-primary" disabled={busy || !name.trim() || name.trim() === saved} onClick={() => void save()} data-testid="v12-settings-profile-save">Save</button></span>
          </span>
        </div>
        {note ? <Note ok={note.ok} text={note.text} testId="v12-settings-profile-note" /> : null}
      </Sec>
      <Sec label="Session">
        <div className="v12-ws-row">
          <span className="v12-ws-row-k"><span>Signed in</span><span className="v12-ws-row-line">{personLine({ name: session.name, email: session.email })} · {role}{session.workspace?.name ? ` of ${session.workspace.name}` : ""}</span></span>
          <button type="button" className="v12-ws-btn" onClick={() => void signOut(scoped)} data-testid="v12-settings-signout">Sign out</button>
        </div>
      </Sec>
    </>
  );
}
