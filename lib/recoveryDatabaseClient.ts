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
    return readOnly(stmt)
      ? run()
      : withRecoveryActivity("database-statement", run, {
          uncertainOnError: (error) => this.uncertain(error),
        });
  }
  batch(stmts: Parameters<Client["batch"]>[0], mode?: TransactionMode) {
    return withRecoveryActivity(
      "database-batch",
      () => this.native.batch(stmts, mode),
      { uncertainOnError: (error) => this.uncertain(error) },
    );
  }
  migrate(stmts: InStatement[]) {
    return withRecoveryActivity(
      "database-migrate",
      () => this.native.migrate(stmts),
      { uncertainOnError: (error) => this.uncertain(error) },
    );
  }
  executeMultiple(sql: string) {
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
    return {
      execute: (stmt) => native.execute(stmt),
      batch: (stmts) => native.batch(stmts),
      executeMultiple: (sql) => native.executeMultiple(sql),
      async commit() {
        try {
          await native.commit();
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
