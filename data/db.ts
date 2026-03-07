import { Database as BunSQLite, type SQLQueryBindings } from "bun:sqlite";
import postgres from "postgres";
import { join } from "path";
import { debug } from "../utils/debug.ts";

const DATABASE_URL = process.env.DATABASE_URL;

// lazily compute sqlite path only when needed
function getSqlitePath(): string {
  return join(import.meta.dir, "crusty.db");
}

// unified query result interface
interface QueryHandle<T> {
  get(...params: unknown[]): T | null;
  all(...params: unknown[]): T[];
}

// unified database interface that works with both sqlite and postgres
export interface DatabaseAdapter {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
  query<T>(sql: string): QueryHandle<T>;
  close(): void;
  readonly type: "sqlite" | "postgres";
}

// async database interface for postgres - used for async operations
export interface AsyncDatabaseAdapter {
  run(sql: string, params?: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  get<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  readonly type: "postgres";
}

// postgres adapter async methods interface - what getAsyncDatabase returns
export interface PostgresAsyncMethods {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  readonly type: "postgres";
}

// sqlite adapter using bun:sqlite
class SQLiteAdapter implements DatabaseAdapter {
  private db: BunSQLite;
  readonly type = "sqlite" as const;

  constructor(path: string) {
    this.db = new BunSQLite(path);
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  run(sql: string, params?: unknown[]): void {
    if (params && params.length > 0) {
      this.db.run(sql, params as SQLQueryBindings[]);
    } else {
      this.db.run(sql);
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query<T>(sql: string): QueryHandle<T> {
    const stmt = this.db.query(sql);
    return {
      get: (...params: unknown[]): T | null =>
        stmt.get(...(params as SQLQueryBindings[])) as T | null,
      all: (...params: unknown[]): T[] =>
        stmt.all(...(params as SQLQueryBindings[])) as T[],
    };
  }

  close(): void {
    this.db.close();
  }
}

// postgres adapter using postgres.js with sync-like interface
// uses a command queue to handle async operations synchronously
// implements DatabaseAdapter for sync operations and has async methods for proper async usage
class PostgresAdapter implements DatabaseAdapter {
  private sql: postgres.Sql;
  readonly type = "postgres" as const;
  private queryCache: Map<
    string,
    { result: unknown[]; params: string; time: number }
  > = new Map();
  private cacheTimeout = 50; // ms
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  // set the init promise so queries can wait for it
  setInitPromise(promise: Promise<void>): void {
    this.initPromise = promise;
    promise.then(() => {
      this.initialized = true;
    });
  }

  // wait for tables to be ready
  private async waitForInit(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  // sync run - queues the operation (waits for init)
  run(sql: string, params?: unknown[]): void {
    const pgSql = this.convertPlaceholders(sql);
    const execute = () => {
      this.sql.unsafe(pgSql, (params || []) as any).catch((err) => {
        console.error("[db:postgres] run error:", err);
      });
    };

    if (!this.initialized && this.initPromise) {
      this.initPromise.then(execute);
    } else {
      execute();
    }
  }

  // async run
  async runAsync(sql: string, params?: unknown[]): Promise<void> {
    await this.waitForInit();
    const pgSql = this.convertPlaceholders(sql);
    await this.sql.unsafe(pgSql, (params || []) as any);
  }

  // sync exec (waits for init)
  // passes the full sql string directly to postgres.js — no splitting needed,
  // and splitting on ";" is incorrect for dollar-quoted blocks ($$...$$)
  exec(sql: string): void {
    const trimmed = sql.trim();
    if (!trimmed) return;

    const execute = () => {
      this.sql.unsafe(trimmed).catch((err) => {
        console.error("[db:postgres] exec error:", err);
      });
    };

    if (!this.initialized && this.initPromise) {
      this.initPromise.then(execute);
    } else {
      execute();
    }
  }

  // async exec
  // same as exec but awaited — no splitting, postgres.js handles multi-statement sql
  async execAsync(sql: string): Promise<void> {
    const trimmed = sql.trim();
    if (!trimmed) return;
    await this.sql.unsafe(trimmed);
  }

  // sync query with caching for repeated calls
  query<T>(sql: string): QueryHandle<T> {
    const pgSql = this.convertPlaceholders(sql);
    const adapter = this;

    return {
      get: (...params: unknown[]): T | null => {
        const cacheKey = `${pgSql}:${JSON.stringify(params)}`;
        const cached = adapter.queryCache.get(cacheKey);
        const now = Date.now();

        // return cached result if fresh
        if (cached && now - cached.time < adapter.cacheTimeout) {
          return (cached.result[0] as T) || null;
        }

        // dont queue queries until tables are initialized
        if (!adapter.initialized) {
          return cached ? (cached.result[0] as T) || null : null;
        }

        // queue async fetch for future calls
        adapter.sql
          .unsafe(pgSql, params as any)
          .then((rows) => {
            adapter.queryCache.set(cacheKey, {
              result: rows as unknown[],
              params: JSON.stringify(params),
              time: Date.now(),
            });
          })
          .catch((err) => console.error("[db:postgres] query error:", err));

        // return stale cache or null
        return cached ? (cached.result[0] as T) || null : null;
      },
      all: (...params: unknown[]): T[] => {
        const cacheKey = `${pgSql}:${JSON.stringify(params)}`;
        const cached = adapter.queryCache.get(cacheKey);
        const now = Date.now();

        if (cached && now - cached.time < adapter.cacheTimeout) {
          return cached.result as T[];
        }

        // dont queue queries until tables are initialized
        if (!adapter.initialized) {
          return cached ? (cached.result as T[]) : [];
        }

        adapter.sql
          .unsafe(pgSql, params as any)
          .then((rows) => {
            adapter.queryCache.set(cacheKey, {
              result: rows as unknown[],
              params: JSON.stringify(params),
              time: Date.now(),
            });
          })
          .catch((err) => console.error("[db:postgres] query error:", err));

        return cached ? (cached.result as T[]) : [];
      },
    };
  }

  // async get
  async get<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    await this.waitForInit();
    const pgSql = this.convertPlaceholders(sql);
    const rows = await this.sql.unsafe(pgSql, params as any);
    return (rows[0] as T) || null;
  }

  // async all
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    await this.waitForInit();
    const pgSql = this.convertPlaceholders(sql);
    const rows = await this.sql.unsafe(pgSql, params as any);
    return rows as unknown as T[];
  }

  private convertPlaceholders(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  close(): void {
    this.sql
      .end()
      .catch((err) => console.error("[db:postgres] close error:", err));
  }

  // async close
  async closeAsync(): Promise<void> {
    await this.sql.end();
  }
}

// singleton instances
let db: DatabaseAdapter | null = null;
let pgAdapter: PostgresAdapter | null = null;

// detect if we should use postgres
export function isUsingPostgres(): boolean {
  return !!DATABASE_URL && DATABASE_URL.startsWith("postgres");
}

// get the sync database adapter (for sqlite or postgres with sync wrapper)
export function getDatabase(): DatabaseAdapter {
  if (!db) {
    if (isUsingPostgres()) {
      debug("[db] using postgresql database");
      pgAdapter = new PostgresAdapter(DATABASE_URL!);
      db = pgAdapter;
      // init tables async for postgres and register the promise so queries can wait
      const initPromise = initTablesAsync();
      pgAdapter.setInitPromise(initPromise);
      initPromise.catch((err) => console.error("[db] init error:", err));
    } else {
      debug("[db] using sqlite database");
      db = new SQLiteAdapter(getSqlitePath());
      initTables();
    }
  }
  return db;
}

// get async postgres adapter for proper async operations
export function getAsyncDatabase(): PostgresAsyncMethods | null {
  if (!isUsingPostgres()) return null;
  if (!pgAdapter) {
    getDatabase(); // ensure initialized
  }
  if (!pgAdapter) return null;

  // return a wrapper that exposes the async methods
  const adapter = pgAdapter;
  return {
    type: "postgres" as const,
    run: (sql: string, params?: unknown[]) => adapter.runAsync(sql, params),
    get: <T>(sql: string, ...params: unknown[]) =>
      adapter.get<T>(sql, ...params),
    all: <T>(sql: string, ...params: unknown[]) =>
      adapter.all<T>(sql, ...params),
  };
}

function initTables(): void {
  if (!db || db.type === "postgres") return;

  // sqlite tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      code TEXT,
      created_at INTEGER,
      expires_at INTEGER,
      used INTEGER DEFAULT 0,
      paired_user_id INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS self_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      tag TEXT NOT NULL CHECK (tag IN ('confidence', 'uncertainty', 'speed', 'depth')),
      miss TEXT NOT NULL,
      fix TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      task TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
      estimated_effort TEXT,
      completed INTEGER DEFAULT 0,
      item_order INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      raw_content TEXT,
      keywords TEXT NOT NULL,
      emotional_weight INTEGER DEFAULT 5,
      timestamp INTEGER NOT NULL,
      last_recalled INTEGER,
      recall_count INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled'))
    )
  `);

  // learnings table for the learning machine (self-improving knowledge)
  db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('error_pattern', 'gotcha', 'fix', 'preference', 'workflow', 'context')),
      tool_name TEXT,
      error_type TEXT,
      keywords TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      application_count INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL,
      last_applied INTEGER
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_todo_items_todo ON todo_items(todo_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_self_review_date ON self_review(date)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memories_keywords ON memories(keywords)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status, remind_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_learnings_user ON learnings(user_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_learnings_tool ON learnings(tool_name)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_skill_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_hash TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      reason TEXT NOT NULL,
      blocked_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_blocked_skill_urls_hash ON blocked_skill_urls(url_hash)`,
  );

  // skills table for persisting dynamically created or url-loaded skills
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('wizard', 'url', 'imported')),
      source_url TEXT,
      license TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`);

  // hooks table for persisting dynamically created hooks
  db.exec(`
    CREATE TABLE IF NOT EXISTS hooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT NOT NULL,
      every TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      timezone TEXT,
      days TEXT,
      start_time TEXT,
      end_time TEXT,
      source_type TEXT NOT NULL CHECK (source_type IN ('filesystem', 'wizard', 'url', 'imported')),
      source_url TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hooks_name ON hooks(name)`);

  // heartbeat items table for user-customizable actionable items
  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  debug("[db] tables initialized");
}

async function initTablesAsync(): Promise<void> {
  if (!pgAdapter) return;

  // suppress postgres NOTICE messages for "already exists, skipping"
  await pgAdapter.execAsync(`SET client_min_messages TO WARNING`);

  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS pairing (
      id INTEGER PRIMARY KEY,
      code TEXT,
      created_at BIGINT,
      expires_at BIGINT,
      used INTEGER DEFAULT 0,
      paired_user_id BIGINT
    )
  `);

  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS self_review (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      tag TEXT NOT NULL CHECK (tag IN ('confidence', 'uncertainty', 'speed', 'depth')),
      miss TEXT NOT NULL,
      fix TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS todo_items (
      id SERIAL PRIMARY KEY,
      todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      task TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
      estimated_effort TEXT,
      completed INTEGER DEFAULT 0,
      item_order INTEGER NOT NULL
    )
  `);

  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      content TEXT NOT NULL,
      raw_content TEXT,
      keywords TEXT NOT NULL,
      emotional_weight INTEGER DEFAULT 5,
      timestamp BIGINT NOT NULL,
      last_recalled BIGINT,
      recall_count INTEGER DEFAULT 0
    )
  `);

  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      message TEXT NOT NULL,
      remind_at BIGINT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled'))
    )
  `);

  // learnings table for the learning machine (self-improving knowledge)
  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('error_pattern', 'gotcha', 'fix', 'preference', 'workflow', 'context')),
      tool_name TEXT,
      error_type TEXT,
      keywords TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      application_count INTEGER DEFAULT 0,
      timestamp BIGINT NOT NULL,
      last_applied BIGINT
    )
  `);

  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_todo_items_todo ON todo_items(todo_id)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_self_review_date ON self_review(date)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_memories_keywords ON memories(keywords)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status, remind_at)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_learnings_user ON learnings(user_id)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category)`,
  );
  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_learnings_tool ON learnings(tool_name)`,
  );

  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS blocked_skill_urls (
      id SERIAL PRIMARY KEY,
      url_hash TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      reason TEXT NOT NULL,
      blocked_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pgAdapter.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_blocked_skill_urls_hash ON blocked_skill_urls(url_hash)`,
  );

  // skills table for persisting dynamically created or url-loaded skills
  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS skills (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('wizard', 'url', 'imported')),
      source_url TEXT,
      license TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pgAdapter.execAsync(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name ON skills(name)`,
  );

  // hooks table for persisting dynamically created hooks
  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS hooks (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT NOT NULL,
      every TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      timezone TEXT,
      days TEXT,
      start_time TEXT,
      end_time TEXT,
      source_type TEXT NOT NULL CHECK (source_type IN ('filesystem', 'wizard', 'url', 'imported')),
      source_url TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
      updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pgAdapter.execAsync(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_hooks_name ON hooks(name)`,
  );

  // heartbeat items table for user-customizable actionable items
  await pgAdapter.execAsync(`
    CREATE TABLE IF NOT EXISTS heartbeat_items (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  // restore default message level
  await pgAdapter.execAsync(`SET client_min_messages TO NOTICE`);

  debug("[db] postgres tables initialized");
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    pgAdapter = null;
    debug("[db] closed");
  }
}

export async function closeDatabaseAsync(): Promise<void> {
  if (pgAdapter) {
    await pgAdapter.closeAsync();
    db = null;
    pgAdapter = null;
    debug("[db] closed");
  } else if (db) {
    db.close();
    db = null;
    debug("[db] closed");
  }
}
