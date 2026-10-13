import type {
  Client,
  InArgs,
  InStatement,
  Transaction,
  TransactionMode,
} from "@libsql/client";
import { recoveryAdmission, withRecoveryActivity } from "./recovery";

/** No SQL rewriting or retries. Unknown statements, CTEs, PRAGMAs and every
 * transaction are guarded. A plain SELECT can serve maintenance diagnostics. */
const readOnly = (stmt: InStatement) => {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  return (
    /^\s*SELECT\b/i.test(sql) && !sql.trim().replace(/;$/, "").includes(";")
  );
};
export class RecoveryDatabaseClient implements Client {
  constructor(private native: Client) {}
  /**
   * Counts the writes made through this client (each statement that is not a plain SELECT, and each committed transaction that wrote). A cached "no"
   * (lib/uploadAccess.ts) is trusted only while this has not moved, so any write that could have granted access ends it at once.
   */
  writeGeneration = 0;
  private uncertain(error: unknown) {
    if (this.protocol === "file") return false;
    // A server SQL rejection is an acknowledged end to the statement, not a
    // lost transport outcome. Unknown/network/IO failures remain blockers.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    return !/^SQLITE_(BUSY|LOCKED|CONSTRAINT|MISMATCH|RANGE|TOOBIG|READONLY|ERROR)(_|$)/.test(
      code,
    );
  }
  get closed() {
    return this.native.closed;
  }
  get protocol() {
    return this.native.protocol;
  }
  execute(stmt: InStatement): ReturnType<Client["execute"]>;
  execute(sql: string, args?: InArgs): ReturnType<Client["execute"]>;
  execute(stmt: InStatement, args?: InArgs) {
    const run = () =>
      typeof stmt === "string"
        ? this.native.execute(stmt, args)
        : this.native.execute(stmt);
    if (readOnly(stmt)) return run();
    this.writeGeneration++;
    return withRecoveryActivity("database-statement", run, {
      uncertainOnError: (error) => this.uncertain(error),
    }).finally(() => { this.writeGeneration++; });
  }
  batch(stmts: Parameters<Client["batch"]>[0], mode?: TransactionMode) {
    this.writeGeneration++;
    return withRecoveryActivity(
      "database-batch",
      () => this.native.batch(stmts, mode),
      { uncertainOnError: (error) => this.uncertain(error) },
    ).finally(() => { this.writeGeneration++; });
  }
  migrate(stmts: InStatement[]) {
    this.writeGeneration++;
    return withRecoveryActivity(
      "database-migrate",
      () => this.native.migrate(stmts),
      { uncertainOnError: (error) => this.uncertain(error) },
    );
  }
  executeMultiple(sql: string) {
    this.writeGeneration++;
    return withRecoveryActivity(
      "database-multiple",
      () => this.native.executeMultiple(sql),
      { uncertainOnError: (error) => this.uncertain(error) },
    );
  }
  sync() {
    return withRecoveryActivity("database-sync", () => this.native.sync(), {
      uncertainOnError: true,
    });
  }
  reconnect() {
    return this.native.reconnect();
  }
  close() {
    this.native.close();
  }
  async transaction(mode?: TransactionMode): Promise<Transaction> {
    const admission = await recoveryAdmission("database-transaction");
    let native: Transaction;
    try {
      native = await this.native.transaction(mode);
    } catch (error) {
      await admission.finish(this.uncertain(error));
      throw error;
    }
    let uncertain = false;
    let ended = false;
    const local = this.protocol === "file";
    const finish = () => admission.finish(uncertain);
    const bump = () => { this.writeGeneration++; };
    let wrote = false;
    return {
      execute: (stmt) => { if (!readOnly(stmt)) { wrote = true; bump(); } return native.execute(stmt); },
      batch: (stmts) => { wrote = true; bump(); return native.batch(stmts); },
      executeMultiple: (sql) => { wrote = true; bump(); return native.executeMultiple(sql); },
      async commit() {
        try {
          await native.commit();
          if (wrote) bump();
          ended = true;
          await finish();
        } catch (error) {
          uncertain = true;
          throw error;
        }
      },
      async rollback() {
        try {
          await native.rollback();
          ended = true;
          // Acknowledged rollback is evidence the transaction has ended.
          uncertain = false;
          await finish();
        } catch (error) {
          uncertain = true;
          throw error;
        }
      },
      close() {
        // Remote close is synchronous and may only enqueue stream cleanup.
        // Without an acknowledged end it cannot prove the write lock is gone.
        if (!local && !ended) uncertain = true;
        try {
          native.close();
        } catch (error) {
          uncertain = true;
          throw error;
        } finally {
          void finish().catch(() => {
            /* An unacknowledged release remains a durable blocker. */
          });
        }
      },
      get closed() {
        return native.closed;
      },
    };
  }
}
export const fenceDatabase = (client: Client) =>
  new RecoveryDatabaseClient(client);

/** The writes made through a tenant client so far (see RecoveryDatabaseClient.writeGeneration); NaN for a client that is not fenced, which never equals itself, so nothing is cached against it. */
export const writeGenerationOf = (client: Client): number => (client instanceof RecoveryDatabaseClient ? client.writeGeneration : Number.NaN);
