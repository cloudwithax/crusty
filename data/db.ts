import { Database } from "bun:sqlite";
import { join } from "path";
import { debug } from "../utils/debug.ts";

const DB_PATH = join(import.meta.dir, "crusty.db");

// singleton database instance
let db: Database | null = null;

export function getDatabase(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    initTables();
  }
  return db;
}

function initTables(): void {
  const database = db!;

  // pairing table
  database.exec(`
    CREATE TABLE IF NOT EXISTS pairing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      code TEXT,
      created_at INTEGER,
      expires_at INTEGER,
      used INTEGER DEFAULT 0,
      paired_user_id INTEGER
    )
  `);

  // self review entries
  database.exec(`
    CREATE TABLE IF NOT EXISTS self_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      tag TEXT NOT NULL CHECK (tag IN ('confidence', 'uncertainty', 'speed', 'depth')),
      miss TEXT NOT NULL,
      fix TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // todos
  database.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // todo items
  database.exec(`
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

  // index for faster lookups
  database.exec(`CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_todo_items_todo ON todo_items(todo_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_self_review_date ON self_review(date)`);

  debug("[db] tables initialized");
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    debug("[db] closed");
  }
}
