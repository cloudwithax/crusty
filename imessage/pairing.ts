// imessage pairing system - separate from telegram pairing
// uses phone number instead of numeric user id
// stored in imessage_pairing table with same single-row pattern

import { randomBytes } from "crypto";
import { getDatabase } from "../data/db.ts";
import { debug } from "../utils/debug.ts";

// ensure the imessage pairing table exists
function ensureTable(): void {
  const db = getDatabase();
  if (db.type === "sqlite") {
    db.exec(`
      CREATE TABLE IF NOT EXISTS imessage_pairing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        code TEXT,
        created_at INTEGER,
        expires_at INTEGER,
        used INTEGER DEFAULT 0,
        paired_phone TEXT
      )
    `);
  }
}

// for postgres, call this during async init
export async function ensureImessagePairingTableAsync(): Promise<void> {
  // sqlite is handled synchronously in ensureTable
  // postgres support can be added here if needed
  ensureTable();
}

interface ImessagePairingData {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  pairedPhone?: string;
}

export function generateImessagePairingCode(): string {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

export function saveImessagePairingCode(
  code: string,
  expiresInMinutes: number = 60,
): void {
  ensureTable();
  const db = getDatabase();
  const now = Date.now();
  const expiresAt = now + expiresInMinutes * 60 * 1000;

  db.run(
    `INSERT INTO imessage_pairing (id, code, created_at, expires_at, used, paired_phone)
     VALUES (1, ?, ?, ?, 0, NULL)
     ON CONFLICT (id) DO UPDATE SET
       code = EXCLUDED.code,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at,
       used = EXCLUDED.used,
       paired_phone = EXCLUDED.paired_phone`,
    [code, now, expiresAt],
  );
}

export function loadImessagePairingData(): ImessagePairingData | null {
  ensureTable();
  const db = getDatabase();
  const row = db
    .query<{
      code: string;
      created_at: number;
      expires_at: number;
      used: number;
      paired_phone: string | null;
    }>(
      "SELECT code, created_at, expires_at, used, paired_phone FROM imessage_pairing WHERE id = 1",
    )
    .get();

  if (!row) return null;

  return {
    code: row.code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: row.used === 1,
    pairedPhone: row.paired_phone ?? undefined,
  };
}

export function markImessagePaired(phone: string): void {
  ensureTable();
  const db = getDatabase();
  db.run(
    "UPDATE imessage_pairing SET used = 1, paired_phone = ? WHERE id = 1",
    [phone],
  );
  debug(`[imessage] paired with ${phone}`);
}

export function isValidImessagePairingCode(code: string): boolean {
  const data = loadImessagePairingData();
  if (!data) return false;
  if (data.used) return false;
  if (Date.now() > data.expiresAt) return false;
  return data.code === code.toUpperCase().trim();
}

export function isImessagePaired(phone: string): boolean {
  const data = loadImessagePairingData();
  if (!data) return false;
  return data.used && data.pairedPhone === phone;
}

export function isImessageSystemPaired(): boolean {
  const data = loadImessagePairingData();
  if (!data) return false;
  return data.used;
}

export function getImessagePairingCodeRemainingMinutes(): number | null {
  const data = loadImessagePairingData();
  if (!data || data.used) return null;
  const remaining = Math.ceil((data.expiresAt - Date.now()) / (60 * 1000));
  return remaining > 0 ? remaining : 0;
}

export function clearImessagePairing(): void {
  ensureTable();
  const db = getDatabase();
  db.run("DELETE FROM imessage_pairing WHERE id = 1");
}

export function clearImessagePairingForNewCode(): void {
  ensureTable();
  const db = getDatabase();
  db.run("DELETE FROM imessage_pairing WHERE id = 1");
}
