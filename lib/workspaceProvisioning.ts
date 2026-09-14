import { withRecoveryActivity } from './recovery';
import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { accountDbReady, accountTransaction, AccountError } from "./accountDb";
import {
  platformDb,
  now,
  newId,
  getWorkspace,
  rowToWorkspace,
  platformKeysByDefault,
  getPlatformLayer,
} from "./platform";
import { provisionTenantDatabase, provisioningConfigured } from "./provision";
import { keyringConfigured, seal, open } from "./keyring";
import { signupCredits } from "./creditTerms";
import { runInTenant, type TenantWorkspace } from "./tenant";

export type WorkspaceOwner = { id: string; email: string; name: string };
export type ProvisioningInfo = {
  requestId: string;
  name: string;
  state: "pending" | "provisioning" | "failed";
  error: string | null;
};
type ProvisionRow = {
  request_id: string;
  request_key: string;
  owner_id: string;
  workspace_id: string;
  name: string;
  slug: string;
  db_name: string;
  db_url: string | null;
  db_token_enc: string | null;
  state: string;
  lease_token: string | null;
  lease_until: number | null;
  welcome_source: string | null;
  welcome_credits: number;
  last_error: string | null;
  created_at: number;
};
const info = (r: ProvisionRow): ProvisioningInfo => ({
  requestId: r.request_id,
  name: r.name,
  state:
    r.state === "provisioning"
      ? "provisioning"
      : r.state === "failed"
        ? "failed"
        : "pending",
  error: r.last_error,
});
export function workspaceCreationReadiness() {
  const open = provisioningConfigured() && keyringConfigured();
  return {
    canCreate: open,
    ...(!open
      ? {
          reason:
            "Workspace creation is being configured. Your account and pending workspace requests will be kept.",
        }
      : {}),
  };
}

/** Reserve identifiers and capacity before any resource call. Approved invitation
 * grants are supplied only by the server's single-use invitation transaction. */
export async function prepareWorkspace(
  tx: Transaction,
  input: {
    owner: WorkspaceOwner;
    name: string;
    requestKey?: string;
    welcomeSource?: string;
    welcomeCredits?: number;
  },
): Promise<string> {
  const name = input.name.trim();
  if (!name || name.length > 80)
    throw new AccountError("Use a workspace name between 1 and 80 characters.");
  const account = (
    await tx.execute({
      sql: "SELECT id FROM accounts WHERE id=? AND disabled=0 AND deleted_at IS NULL",
      args: [input.owner.id],
    })
  ).rows[0];
  if (!account)
    throw new AccountError("This account is no longer available.", 403);
  const key =
    input.owner.id +
    ":" +
    (input.requestKey ?? "workspace:" + name.toLowerCase());
  const previous = (
    await tx.execute({
      sql: "SELECT * FROM workspace_provisioning WHERE request_key=?",
      args: [key],
    })
  ).rows[0] as unknown as ProvisionRow | undefined;
  if (previous) {
    if (previous.name !== name)
      throw new AccountError(
        "This request already names a different workspace.",
        409,
      );
    return previous.request_id;
  }
  const count = Number(
    (
      await tx.execute({
        sql: `SELECT
  (SELECT COUNT(*) FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.account_id=? AND m.role='owner' AND w.deleted_at IS NULL)+
  (SELECT COUNT(*) FROM workspace_provisioning WHERE owner_id=? AND state<>'ready') AS n`,
        args: [input.owner.id, input.owner.id],
      })
    ).rows[0].n,
  );
  if (count >= 5)
    throw new AccountError(
      "Five workspaces of your own is the ceiling. Finish an existing workspace request or contact support.",
      409,
    );
  const id = newId("ws"),
    requestId = newId("wsp");
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "studio";
  const slug = base + "-" + id.slice(-8),
    dbName = "particl-" + id.replace(/^ws_/, "");
  await tx.execute({
    sql: `INSERT INTO workspace_provisioning(request_id,request_key,owner_id,workspace_id,name,slug,db_name,welcome_source,welcome_credits,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      requestId,
      key,
      input.owner.id,
      id,
      name,
      slug,
      dbName,
      input.welcomeSource ?? null,
      input.welcomeSource ? Math.max(0, input.welcomeCredits ?? 0) : 0,
      now(),
      now(),
    ],
  });
  return requestId;
}
export async function requestWorkspace(input: {
  owner: WorkspaceOwner;
  name: string;
  requestKey?: string;
}): Promise<string> {
return await withRecoveryActivity('provisioning', async () => {

  return accountTransaction((tx) => prepareWorkspace(tx, input));

});
}
export async function pendingWorkspaces(
  ownerId: string,
): Promise<ProvisioningInfo[]> {
  await accountDbReady();
  return (
    await platformDb().execute({
      sql: "SELECT * FROM workspace_provisioning WHERE owner_id=? AND state<>'ready' ORDER BY created_at",
      args: [ownerId],
    })
  ).rows.map((r) => info(r as unknown as ProvisionRow));
}
export type ProvisioningResult =
  | { workspace: TenantWorkspace; provisioning?: never }
  | { workspace?: never; provisioning: ProvisioningInfo };
/** No account is rolled back on a provisioning error. A deterministic database
 * name and fenced lease make a server interruption resumable without duplicates. */
export async function resumeWorkspace(
  requestId: string,
  ownerId: string,
): Promise<ProvisioningResult> {
return await withRecoveryActivity('provisioning', async () => {

  await accountDbReady();
  const lease = randomUUID();
  const claimed = await accountTransaction(async (tx) => {
    const r = (
      await tx.execute({
        sql: "SELECT * FROM workspace_provisioning WHERE request_id=? AND owner_id=?",
        args: [requestId, ownerId],
      })
    ).rows[0] as unknown as ProvisionRow | undefined;
    if (!r) throw new AccountError("No such workspace request.", 404);
    if (r.state === "ready") return { row: r, owns: false };
    if (r.lease_until && Number(r.lease_until) > now())
      return { row: r, owns: false };
    const readiness = workspaceCreationReadiness();
    if (!readiness.canCreate) {
      r.state = "pending";
      r.last_error = readiness.reason ?? null;
      await tx.execute({
        sql: "UPDATE workspace_provisioning SET state='pending',last_error=?,updated_at=? WHERE request_id=?",
        args: [r.last_error, now(), requestId],
      });
      return { row: r, owns: false };
    }
    await tx.execute({
      sql: "UPDATE workspace_provisioning SET state='provisioning',lease_token=?,lease_until=?,attempts=attempts+1,last_error=NULL,updated_at=? WHERE request_id=?",
      args: [lease, now() + 300_000, now(), requestId],
    });
    return {
      row: { ...r, state: "provisioning", last_error: null },
      owns: true,
    };
  });
  const row = claimed.row;
  if (row.state === "ready") {
    const ws = await getWorkspace(row.workspace_id);
    if (!ws || ws.deletedAt)
      throw new AccountError("This workspace has been deleted.", 410);
    return { workspace: ws };
  }
  if (!claimed.owns) return { provisioning: info(row) };
  try {
    const account = (
      await platformDb().execute({
        sql: "SELECT id,email,name FROM accounts WHERE id=? AND disabled=0 AND deleted_at IS NULL",
        args: [ownerId],
      })
    ).rows[0];
    if (!account)
      throw new AccountError("This account is no longer available.", 403);
    let url = row.db_url,
      token = row.db_token_enc ? open(row.db_token_enc) : null;
    if (!url) {
      const resource = await provisionTenantDatabase(row.slug, row.db_name);
      url = resource.url;
      token = resource.token;
      const saved = await platformDb().execute({
        sql: "UPDATE workspace_provisioning SET db_url=?,db_token_enc=?,updated_at=? WHERE request_id=? AND lease_token=?",
        args: [url, token ? seal(token) : null, now(), requestId, lease],
      });
      if (!saved.rowsAffected)
        throw new AccountError(
          "Another request is finishing this workspace. Retry shortly.",
          409,
        );
    }
    const usePlatform = platformKeysByDefault();
    const ws = rowToWorkspace({
      id: row.workspace_id,
      slug: row.slug,
      name: row.name,
      db_url: url,
      db_token_enc: token ? seal(token) : null,
      owner_id: ownerId,
      legacy: 0,
      uses_platform_keys: usePlatform ? 1 : 0,
      plan_id: "invite",
      created_at: row.created_at,
    });
    // Initialize the tenant and its owner mirror before publishing a membership.
    // Failed initialization leaves only a resumable provisioning request.
    await runInTenant(ws, async () => {
      const { db, ready } = await import("./db");
      await ready();
      await db().execute({
        sql: `INSERT INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES(?,?,?,'!','admin',0,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,role='admin',disabled=0,deleted_at=NULL`,
        args: [ownerId, String(account.email), String(account.name), now()],
      });
    });
    await accountTransaction(async (tx) => {
      const active = (
        await tx.execute({
          sql: "SELECT 1 FROM workspace_provisioning WHERE request_id=? AND lease_token=? AND state='provisioning'",
          args: [requestId, lease],
        })
      ).rows[0];
      if (!active)
        throw new AccountError(
          "Another request is finishing this workspace. Retry shortly.",
          409,
        );
      const live = (
        await tx.execute({
          sql: "SELECT id FROM accounts WHERE id=? AND disabled=0 AND deleted_at IS NULL",
          args: [ownerId],
        })
      ).rows[0];
      if (!live)
        throw new AccountError("This account is no longer available.", 403);
      await tx.execute({
        sql: `INSERT INTO workspaces(id,slug,name,db_url,db_token_enc,db_name,legacy,uses_platform_keys,owner_id,plan_id,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?,?,?,?)`,
        args: [
          ws.id,
          ws.slug,
          ws.name,
          url,
          token ? seal(token) : null,
          row.db_name,
          usePlatform ? 1 : 0,
          ownerId,
          "invite",
          row.created_at,
          now(),
        ],
      });
      await tx.execute({
        sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'owner',?)",
        args: [ws.id, ownerId, now()],
      });
      if (usePlatform && row.welcome_source && row.welcome_credits > 0)
        await tx.execute({
          sql: `INSERT OR IGNORE INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,'Approved invitation welcome credits','welcome',?,?)`,
          args: [
            "welcome:" + ws.id,
            ws.id,
            row.welcome_credits,
            ownerId,
            now(),
          ],
        });
      await tx.execute({
        sql: "UPDATE workspace_provisioning SET state='ready',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE request_id=? AND lease_token=?",
        args: [now(), requestId, lease],
      });
    });
    return { workspace: (await getWorkspace(ws.id))! };
  } catch (error) {
    const message =
      error instanceof AccountError
        ? error.message
        : "Workspace setup could not finish. Retry this same workspace request; your account and existing resources have been kept.";
    await platformDb()
      .execute({
        sql: "UPDATE workspace_provisioning SET state='failed',lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE request_id=? AND lease_token=?",
        args: [message, now(), requestId, lease],
      })
      .catch(() => {});
    // The final commit may have succeeded while its response was lost.
    const current = (
      await platformDb().execute({
        sql: "SELECT * FROM workspace_provisioning WHERE request_id=? AND owner_id=?",
        args: [requestId, ownerId],
      })
    ).rows[0] as unknown as ProvisionRow;
    if (current.state === "ready") {
      const ws = await getWorkspace(current.workspace_id);
      if (ws && !ws.deletedAt) return { workspace: ws };
    }
    return { provisioning: info(current) };
  }

});
}
export async function approvedWelcomeCredits(): Promise<number> {
  return (await getPlatformLayer()).caps.signupCredits ?? signupCredits();
}
