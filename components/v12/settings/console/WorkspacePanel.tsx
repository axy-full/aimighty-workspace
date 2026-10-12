"use client";
import { useState } from "react";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { deleteTypedOk } from "@/lib/v12/settingsConsole";
import { useRead, useWrite } from "@/components/graphite/settings/use-settings";
import { Note, Sec, initialsOf } from "./parts";
import type { TeamBody } from "./People";

/**
 * Settings › Workspace: its name, and the things you cannot undo. The owner renames it and deletes it (the typed name is checked
 * again by the server, which refuses any other); an admin who is not the owner can leave it, unless they are the only admin.
 * Each of these leaves a line in the workspace's history. There is no logo here: uploads are filed under a board, and nothing
 * uploads a workspace's mark yet (the `brandLogoUploadId` setting that review pages read has no uploader).
 */
export function WorkspacePanel() {
  const session = useSession();
  const write = useWrite();
  const { toast } = useWorkspace();
  const name = session.workspace?.name ?? "";
  const owner = session.role === "owner";
  const team = useRead<TeamBody>("/api/team");
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [leaving, setLeaving] = useState(false);
  const admins = (team.data?.users ?? []).filter((u) => !u.disabled && (u.role === "admin" || u.standing === "owner") && u.id !== session.userId).length;
  const onlyAdmin = Boolean(team.data) && admins === 0;

  const rename = async () => {
    setBusy("rename"); setNote(null);
    const { error } = await write("/api/workspaces", "PATCH", { name: draft.trim() });
    setBusy(null);
    if (error) { setNote({ ok: false, text: error }); return; }
    toast("Workspace renamed.");
    window.location.reload();
  };
  const leave = async () => {
    setBusy("leave"); setNote(null);
    const { error } = await write("/api/workspaces/leave", "POST");
    setBusy(null);
    if (error) { setNote({ ok: false, text: error }); setLeaving(false); return; }
    window.location.assign("/login");
  };
  const remove = async () => {
    setBusy("delete"); setNote(null);
    const { error } = await write("/api/workspaces", "DELETE", { name: typed });
    setBusy(null);
    if (error) { setNote({ ok: false, text: error }); return; }
    window.location.assign("/suites");
  };

  return (
    <>
      <Sec label="Name" testId="v12-settings-name">
        <div className="v12-ws-id">
          <span className="v12-ws-av-lg" aria-hidden="true">{initialsOf(name)}</span>
          <span className="v12-ws-stack">
            <input className="v12-ws-field" value={draft} maxLength={80} aria-label="Workspace name" disabled={!owner || busy != null} onChange={(e) => setDraft(e.target.value)}
              title={owner ? undefined : "Only the owner renames the workspace."} data-testid="v12-settings-name-input" />
            <span style={{ display: "inline-flex", gap: 8 }}>
              <button type="button" className="v12-ws-btn v12-ws-btn-primary" disabled={!owner || busy != null || !draft.trim() || draft.trim() === name} onClick={() => void rename()} data-testid="v12-settings-name-save">Save</button>
            </span>
            {!owner ? <span className="v12-ws-row-line">Only the owner renames the workspace.</span> : null}
          </span>
        </div>
      </Sec>

      <Sec label="Danger zone" testId="v12-settings-danger">
        <div className="v12-ws-row">
          <span className="v12-ws-row-k">
            <span>Leave workspace</span>
            <span className="v12-ws-row-line">{owner ? "You own this workspace, so you can’t leave it. Delete it instead." : onlyAdmin ? "You are the only admin. Make someone else an admin first." : "You keep your account and any other workspace. What you made here stays with the workspace."}</span>
          </span>
          {leaving ? (
            <span style={{ display: "inline-flex", gap: 8 }}>
              <button type="button" className="v12-ws-btn v12-ws-btn-danger" disabled={busy != null} onClick={() => void leave()} data-testid="v12-settings-leave-confirm">Leave now</button>
              <button type="button" className="v12-ws-btn" onClick={() => setLeaving(false)}>Stay</button>
            </span>
          ) : (
            <button type="button" className="v12-ws-btn" disabled={owner || onlyAdmin || busy != null || !team.data} title={owner ? "Blocked: you own this workspace." : onlyAdmin ? "Blocked: you are the only admin." : undefined} onClick={() => setLeaving(true)} data-testid="v12-settings-leave">Leave workspace</button>
          )}
        </div>
        <div className="v12-ws-danger" data-testid="v12-settings-delete-box">
          <div className="v12-ws-row" style={{ borderTop: 0, padding: 0 }}>
            <span className="v12-ws-row-k">
              <span style={{ fontWeight: 600 }}>Delete workspace</span>
              <span className="v12-ws-row-line">Every board, take and member goes. Credits are not refunded. {owner ? "This cannot be undone." : "Only the owner can do this."}</span>
            </span>
            <button type="button" className="v12-ws-btn v12-ws-btn-danger" disabled={!owner || busy != null} aria-expanded={deleting} onClick={() => { setDeleting((v) => !v); setTyped(""); }} data-testid="v12-settings-delete">{deleting ? "Keep it" : "Delete workspace…"}</button>
          </div>
          {deleting ? (
            <div className="v12-ws-form" style={{ padding: 0 }}>
              <input className="v12-ws-field" value={typed} placeholder={name} aria-label="Type the workspace name" onChange={(e) => setTyped(e.target.value)} data-testid="v12-settings-delete-name" />
              <span title={deleteTypedOk(typed, name) ? undefined : "Type the workspace name exactly to enable"}>
                <button type="button" className="v12-ws-btn v12-ws-btn-danger" disabled={!deleteTypedOk(typed, name) || busy != null} onClick={() => void remove()} data-testid="v12-settings-delete-confirm">Delete for good</button>
              </span>
            </div>
          ) : null}
        </div>
        {note ? <Note ok={note.ok} text={note.text} testId="v12-settings-workspace-note" /> : null}
      </Sec>
    </>
  );
}
