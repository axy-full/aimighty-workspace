"use client";
import { useState } from "react";
import { Plus, Search, Link2, Mail, Users } from "lucide-react";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { timeAgo } from "@/lib/format";
import { usePageTitle } from "@/lib/usePageTitle";
import { appConfirm, appAlert } from "@/components/dialog";
import WorkspaceSecurity from "@/components/management/WorkspaceSecurity";
import ManagementPage, {
  ManagementCard,
  ManagementNotice,
  ManagementStat,
} from "@/components/management/ManagementPage";

type Member = {
  id: string;
  name: string;
  email: string;
  role?: string;
  disabled: boolean;
  locked: boolean;
  permanent?: boolean;
  clips: number;
  lastSeen: number | null;
};
type Invite = {
  code: string;
  name: string;
  email: string;
  role?: string;
  expiresAt: number;
  sentAt?: number | null;
};
type Team = {
  users: Member[];
  invites: Invite[];
  canSeeRoles?: boolean;
  mail?: { configured: boolean; from?: string | null };
  requests?: {
    id: string;
    name: string;
    email: string;
    note: string;
    createdAt: number;
  }[];
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
export default function TeamPage() {
  const session = useSession();
  return <TeamContent key={`${session.workspace?.id}:${session.email}`} />;
}
function TeamContent() {
  const scopedFetch = useScopedFetch();
  usePageTitle("People");
  const session = useSession();
  const { data, error, refresh } = useApi<Team>("/api/team", 30000);
  const [notice, setNotice] = useState(""),
    [issue, setIssue] = useState(""),
    [busy, setBusy] = useState("");
  const [form, setForm] = useState({ name: "", email: "", role: "member" });
  const [inviteOpen, setInviteOpen] = useState(false),
    [search, setSearch] = useState(""),
    [tab, setTab] = useState("members"),
    [copied, setCopied] = useState("");
  const users = data?.users ?? [],
    invites = data?.invites ?? [],
    owner = Boolean(data?.canSeeRoles),
    mail = Boolean(data?.mail?.configured);
  const filtered = users.filter((user) =>
    `${user.name} ${user.email}`.toLowerCase().includes(search.toLowerCase()),
  );
  const active = users.filter((user) => !user.disabled).length;
  async function mutate(path: string, method: string, body?: unknown) {
    const response = await scopedFetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(result.error || "The team could not be updated.");
    return result;
  }
  async function invite() {
    if (busy) return;
    setBusy("invite");
    setIssue("");
    setNotice("");
    try {
      const result = await mutate("/api/team", "POST", form);
      setForm({ name: "", email: "", role: "member" });
      setInviteOpen(false);
      setTab("invites");
      setNotice(
        result.sent
          ? `Invitation sent to ${result.email}.`
          : result.mailError
            ? "Invitation created. Email delivery failed; copy the invitation link."
            : "Invitation created. Copy the link to share it.",
      );
      await refresh();
    } catch (e) {
      setIssue((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function memberAction(user: Member, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(user.id);
    setIssue("");
    try {
      await mutate(`/api/team/${encodeURIComponent(user.id)}`, "PATCH", body);
      await refresh();
      setNotice(`${user.name} updated.`);
    } catch (e) {
      setIssue((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function remove(user: Member) {
    if (
      busy ||
      !(await appConfirm(
        `Remove ${user.name}?`,
        "They lose access to this workspace. Their takes and recorded usage remain.",
        { confirmLabel: "Remove member", danger: true },
      ))
    )
      return;
    setBusy(user.id);
    setIssue("");
    try {
      await mutate(`/api/team/${encodeURIComponent(user.id)}`, "DELETE");
      await refresh();
      setNotice(`${user.name} removed from this workspace.`);
    } catch (e) {
      setIssue((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function invitationAction(invite: Invite, send: boolean) {
    if (busy) return;
    if (
      !send &&
      !(await appConfirm(
        "Revoke this invitation?",
        `${invite.name} will no longer be able to join using this link.`,
        { confirmLabel: "Revoke invitation", danger: true },
      ))
    )
      return;
    setBusy(invite.code);
    setIssue("");
    try {
      await mutate(
        `/api/team/invites/${encodeURIComponent(invite.code)}${send ? "/send" : ""}`,
        send ? "POST" : "DELETE",
      );
      await refresh();
      setNotice(
        send ? `Invitation emailed to ${invite.email}.` : "Invitation revoked.",
      );
    } catch (e) {
      setIssue((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function copy(code: string) {
    const url = `${window.location.origin}/invite/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(code);
    } catch {
      await appAlert("Copy invitation link", url);
    }
  }
  return (
    <ManagementPage
      tab="team"
      title="People, working together."
      description="Invite your collaborators and manage access to this workspace."
      workspace={session.workspace?.name}
      actions={
        data && (
          <button
            className="management-button primary"
            onClick={() => setInviteOpen(!inviteOpen)}
            aria-expanded={inviteOpen}
          >
            <Plus size={15} />
            {inviteOpen ? "Close invitation" : "Invite someone"}
          </button>
        )
      }
    >
      {(issue || error) && (
        <ManagementNotice error>
          {issue || error}
          {!data && (
            <button
              className="management-button small"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          )}
        </ManagementNotice>
      )}
      {notice && <ManagementNotice>{notice}</ManagementNotice>}
      {session.owner && <WorkspaceSecurity />}
      {!data && !error && (
        <ManagementNotice>
          {session.signedIn
            ? "Loading your team…"
            : "Sign in to manage your workspace team."}
        </ManagementNotice>
      )}
      {data && (
        <>
          <div className="management-grid three management-metrics">
            <ManagementStat
              label="Active people"
              value={active}
              note="Working in this workspace"
            />
            <ManagementStat
              label="Pending invitations"
              value={invites.length}
              note="Links expire after seven days"
            />
            <ManagementStat
              label="Workspace access"
              value={<Users size={30} />}
              note={
                owner
                  ? "You manage roles and access"
                  : "Only the owner changes roles"
              }
            />
          </div>
          {inviteOpen && (
            <ManagementCard
              title="Invite a collaborator"
              description={
                mail
                  ? "Send an invitation to join this workspace."
                  : "Create a private invitation link to share with your collaborator."
              }
            >
              <form
                className="management-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void invite();
                }}
              >
                <div className="management-grid three">
                  <label className="management-field">
                    <span>Name</span>
                    <input
                      required
                      autoComplete="name"
                      maxLength={80}
                      value={form.name}
                      disabled={!!busy}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                    />
                  </label>
                  <label className="management-field">
                    <span>Email address</span>
                    <input
                      required
                      autoComplete="email"
                      type="email"
                      value={form.email}
                      disabled={!!busy}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                    />
                  </label>
                  {owner && (
                    <label className="management-field">
                      <span>Workspace role</span>
                      <select
                        value={form.role}
                        disabled={!!busy}
                        onChange={(e) =>
                          setForm({ ...form, role: e.target.value })
                        }
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    </label>
                  )}
                </div>
                <div className="management-form-footer">
                  <span>
                    Members create and review. Admins also manage workspace
                    settings.
                  </span>
                  <button
                    className="management-button primary"
                    disabled={!!busy || !form.name.trim() || !form.email.trim()}
                  >
                    <Mail size={14} />
                    {busy === "invite"
                      ? "Creating…"
                      : mail
                        ? "Send invite"
                        : "Create invite"}
                  </button>
                </div>
              </form>
            </ManagementCard>
          )}
          {!!data.requests?.length && (
            <ManagementCard title="Access requests">
              {data.requests.map((request) => (
                <div key={request.id} className="management-row">
                  <div>
                    <strong>{request.name || request.email}</strong>
                    <p>{request.email}</p>
                    {request.note && <p>{request.note}</p>}
                  </div>
                  <button
                    className="management-button small"
                    onClick={() => {
                      setForm({
                        name: request.name,
                        email: request.email,
                        role: "member",
                      });
                      setInviteOpen(true);
                    }}
                  >
                    Prepare invitation
                  </button>
                </div>
              ))}
            </ManagementCard>
          )}
          <ManagementCard>
            <div className="management-card-heading">
              <div className="management-tabs" aria-label="People lists">
                <button
                  aria-pressed={tab === "members"}
                  onClick={() => setTab("members")}
                >
                  Members · {users.length}
                </button>
                <button
                  aria-pressed={tab === "invites"}
                  onClick={() => setTab("invites")}
                >
                  Invitations · {invites.length}
                </button>
              </div>
              {tab === "members" && (
                <label className="management-field management-search">
                  <span className="sr-only">Find a person</span>
                  <input
                    placeholder="Find a person…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              )}
            </div>
            {tab === "members" ? (
              <div className="management-list">
                {filtered.map((user) => (
                  <div className="management-member" key={user.id}>
                    <div className="management-identity">
                      <div className="management-avatar">
                        {initials(user.name)}
                      </div>
                      <div>
                        <strong>
                          {user.name}
                          {user.email === session.email ? " (you)" : ""}
                        </strong>
                        <small>{user.email}</small>
                      </div>
                    </div>
                    <div className="management-member-meta">
                      <span>
                        {user.clips} take{user.clips === 1 ? "" : "s"} ·{" "}
                        {user.lastSeen
                          ? `Seen ${timeAgo(user.lastSeen)}`
                          : "Not signed in yet"}
                      </span>
                      <span>
                        <span
                          className={`management-badge ${user.disabled ? "" : "active"}`}
                        >
                          {user.disabled
                            ? "Disabled"
                            : user.locked
                              ? "Locked"
                              : "Active"}
                        </span>
                      </span>
                    </div>
                    <div className="management-member-actions">
                      {owner &&
                        (user.permanent ? (
                          <span className="management-badge">Owner</span>
                        ) : (
                          <select
                            aria-label={`Role for ${user.name}`}
                            value={user.role ?? "member"}
                            disabled={!!busy}
                            onChange={(e) =>
                              void memberAction(user, { role: e.target.value })
                            }
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                        ))}
                      {owner && user.locked && (
                        <button
                          className="management-button small"
                          disabled={!!busy}
                          onClick={() =>
                            void memberAction(user, { unlock: true })
                          }
                        >
                          Unlock
                        </button>
                      )}
                      {owner && !user.permanent && (
                        <>
                          <button
                            className="management-button small"
                            disabled={!!busy}
                            onClick={() =>
                              void memberAction(user, {
                                disabled: !user.disabled,
                              })
                            }
                          >
                            {user.disabled ? "Enable" : "Disable"}
                          </button>
                          {user.email !== session.email && (
                            <button
                              className="management-button small danger"
                              disabled={!!busy}
                              onClick={() => void remove(user)}
                            >
                              Remove
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {!filtered.length && (
                  <div className="management-empty">
                    {search ? (
                      <>
                        <Search size={24} style={{ margin: "0 auto 10px" }} />
                        No matching people.
                      </>
                    ) : (
                      "No members to display."
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="management-list">
                {invites.map((invite) => (
                  <div className="management-member" key={invite.code}>
                    <div className="management-identity">
                      <div className="management-avatar">
                        <Mail size={17} />
                      </div>
                      <div>
                        <strong>{invite.name}</strong>
                        <small>{invite.email}</small>
                      </div>
                    </div>
                    <div className="management-member-meta">
                      <span>
                        {invite.sentAt
                          ? "Invitation emailed"
                          : "Link ready to share"}
                      </span>
                      <span>
                        Expires{" "}
                        {new Date(invite.expiresAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </span>
                    </div>
                    <div className="management-member-actions">
                      <button
                        className="management-button small"
                        onClick={() => void copy(invite.code)}
                      >
                        <Link2 size={12} />
                        {copied === invite.code ? "Copied" : "Copy link"}
                      </button>
                      {mail && (
                        <button
                          className="management-button small"
                          disabled={!!busy}
                          onClick={() => void invitationAction(invite, true)}
                        >
                          Resend
                        </button>
                      )}
                      <button
                        className="management-button small danger"
                        disabled={!!busy}
                        onClick={() => void invitationAction(invite, false)}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
                {!invites.length && (
                  <div className="management-empty">
                    <h2>No pending invitations</h2>
                    <p>Your next collaborator is one invitation away.</p>
                    <button
                      className="management-button"
                      onClick={() => setInviteOpen(true)}
                    >
                      Invite someone
                    </button>
                  </div>
                )}
              </div>
            )}
          </ManagementCard>
          <p className="management-muted">
            Disabling access is reversible. Removing a person keeps their takes
            and recorded usage in this workspace.
          </p>
        </>
      )}
    </ManagementPage>
  );
}
