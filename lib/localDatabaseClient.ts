import {
  createClient,
  type Client,
  type Config,
  type InArgs,
  type InStatement,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareLocalDatabaseDirectory } from "./localDatabase";

const cache = globalThis as typeof globalThis & {
  particlLocalPlatformClients?: Map<string, Client>;
};

function busy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    /^SQLITE_(BUSY|LOCKED)(_|$)/.test(String(error.code))
  );
}

/** Local libSQL detaches its connection during transaction(). Ordinary writes
 * must wait: a BUSY write on the replacement connection can leave it locked.
 * A plain Client preserves adapter introspection; remote clients are unchanged. */
export function createPlatformDatabaseClient(config: Config): Client {
  if (!/^file:/i.test(config.url) && config.url !== ":memory:")
    return createClient(config);
  prepareLocalDatabaseDirectory(config.url);
  const value = config.url.replace(/^file:/i, "");
  const file = value.startsWith("//")
    ? fileURLToPath(config.url)
    : decodeURIComponent(value.split(/[?#]/, 1)[0]);
  const canonical = file === ":memory:" ? config.url : resolve(file);
  // Native SQLite waits on another process's short lock. This driver option
  // applies to transaction replacement connections and reconnects too; a PRAGMA
  // on only the first connection would silently stop protecting later work.
  // Explicit timeout: 0 remains available for callers that require fail-fast.
  const localConfig = { ...config, timeout: config.timeout ?? 2_000 };
  const key = JSON.stringify({ ...localConfig, url: canonical });
  const clients = (cache.particlLocalPlatformClients ??= new Map());
  const existing = clients.get(key);
  if (existing && !existing.closed) return existing;
  const client = new LocalPlatformClient(createClient(localConfig));
  clients.set(key, client);
  return client;
}

class LocalPlatformClient implements Client {
  private turn: Promise<void> = Promise.resolve();
  private transactions = new Set<Transaction>();
  constructor(private native: Client) {}
  get closed() {
    return this.native.closed;
  }
  get protocol() {
    return this.native.protocol;
  }

  private async acquire(): Promise<() => void> {
    const previous = this.turn;
    let release!: () => void;
    this.turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private async recoverBusy(error: unknown): Promise<void> {
    // Another process can still contend with this one. Discard the poisoned
    // native autocommit connection, then report the error without retrying SQL.
    if (busy(error)) await Promise.resolve(this.native.reconnect());
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } catch (error) {
      await this.recoverBusy(error);
      throw error;
    } finally {
      release();
    }
  }

  execute(stmt: InStatement): ReturnType<Client["execute"]>;
  execute(sql: string, args?: InArgs): ReturnType<Client["execute"]>;
  execute(stmt: InStatement, args?: InArgs) {
    return this.run(() =>
      typeof stmt === "string"
        ? this.native.execute(stmt, args)
        : this.native.execute(stmt),
    );
  }
  batch(stmts: Parameters<Client["batch"]>[0], mode?: TransactionMode) {
    return this.run(() => this.native.batch(stmts, mode));
  }
  migrate(stmts: InStatement[]) {
    return this.run(() => this.native.migrate(stmts));
  }
  executeMultiple(sql: string) {
    return this.run(() => this.native.executeMultiple(sql));
  }
  sync() {
    return this.run(() => this.native.sync());
  }
  reconnect() {
    return this.run(() => Promise.resolve(this.native.reconnect()));
  }
  close() {
    try {
      for (const tx of this.transactions) tx.close();
    } finally {
      this.native.close();
    }
  }

  async transaction(mode?: TransactionMode): Promise<Transaction> {
    const release = await this.acquire();
    let native: Transaction;
    try {
      native = await this.native.transaction(mode);
    } catch (error) {
      try {
        await this.recoverBusy(error);
      } finally {
        release();
      }
      throw error;
    }
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      this.transactions.delete(transaction);
      release();
    };
    const transaction: Transaction = {
      execute: (stmt) => native.execute(stmt),
      batch: (stmts) => native.batch(stmts),
      executeMultiple: (sql) => native.executeMultiple(sql),
      async commit() {
        try {
          // The native driver's prepared COMMIT can retain a lock after BUSY,
          // even after rollback. Its batch execution path finalizes correctly.
          await native.executeMultiple("COMMIT");
        } finally {
          if (native.closed) finish();
        }
      },
      async rollback() {
        try {
          await native.rollback();
        } finally {
          if (native.closed) finish();
        }
      },
      close() {
        try {
          native.close();
        } finally {
          finish();
        }
      },
      get closed() {
        return native.closed;
      },
    };
    this.transactions.add(transaction);
    return transaction;
  }
}
