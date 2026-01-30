import { randomBytes } from "crypto";
import { getDatabase, getAsyncDatabase, isUsingPostgres } from "../data/db";

// generate a random pairing code
export function generatePairingCode(): string {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

// save pairing code with expiration
export function savePairingCode(code: string, expiresInMinutes: number = 60): void {
  const db = getDatabase();
  const now = Date.now();
  const expiresAt = now + expiresInMinutes * 60 * 1000;

  db.run(
    `INSERT INTO pairing (id, code, created_at, expires_at, used, paired_user_id) 
     VALUES (1, ?, ?, ?, 0, NULL)
     ON CONFLICT (id) DO UPDATE SET 
       code = EXCLUDED.code,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at,
       used = EXCLUDED.used,
       paired_user_id = EXCLUDED.paired_user_id`,
    [code, now, expiresAt]
  );
}

interface PairingData {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  pairedUserId?: number;
}

export function loadPairingData(): PairingData | null {
  const db = getDatabase();
  const row = db
    .query<{ code: string; created_at: number; expires_at: number; used: number; paired_user_id: number | null }>(
      "SELECT code, created_at, expires_at, used, paired_user_id FROM pairing WHERE id = 1"
    )
    .get();

  if (!row) return null;

  return {
    code: row.code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: row.used === 1,
    pairedUserId: row.paired_user_id ?? undefined,
  };
}

// mark pairing as used by a specific user
export function markPaired(userId: number): void {
  const db = getDatabase();
  db.run("UPDATE pairing SET used = 1, paired_user_id = ? WHERE id = 1", [userId]);
}

// check if a code is valid
export function isValidPairingCode(code: string): boolean {
  const data = loadPairingData();
  if (!data) return false;
  if (data.used) return false;
  if (Date.now() > data.expiresAt) return false;
  return data.code === code.toUpperCase();
}

// check if user is already paired
export function isUserPaired(userId: number): boolean {
  const data = loadPairingData();
  if (!data) return false;
  return data.used && data.pairedUserId === userId;
}

// check if system is paired at all
export function isSystemPaired(): boolean {
  const data = loadPairingData();
  if (!data) return false;
  return data.used;
}

// get remaining time in minutes
export function getPairingCodeRemainingMinutes(): number | null {
  const data = loadPairingData();
  if (!data || data.used) return null;
  const remaining = Math.ceil((data.expiresAt - Date.now()) / (60 * 1000));
  return remaining > 0 ? remaining : 0;
}

// clear pairing data
export function clearPairing(): void {
  const db = getDatabase();
  db.run("DELETE FROM pairing WHERE id = 1");
}

// async versions for postgres support

export async function loadPairingDataAsync(): Promise<PairingData | null> {
  const asyncDb = getAsyncDatabase();
  if (!asyncDb) {
    return loadPairingData();
  }

  const row = await asyncDb.get<{
    code: string;
    created_at: number;
    expires_at: number;
    used: number;
    paired_user_id: number | null;
  }>("SELECT code, created_at, expires_at, used, paired_user_id FROM pairing WHERE id = 1");

  if (!row) return null;

  return {
    code: row.code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: row.used === 1,
    pairedUserId: row.paired_user_id ?? undefined,
  };
}

export async function markPairedAsync(userId: number): Promise<void> {
  const asyncDb = getAsyncDatabase();
  if (!asyncDb) {
    markPaired(userId);
    return;
  }

  await asyncDb.run("UPDATE pairing SET used = 1, paired_user_id = $1 WHERE id = 1", [userId]);
}

export async function isValidPairingCodeAsync(code: string): Promise<boolean> {
  const data = await loadPairingDataAsync();
  if (!data) return false;
  if (data.used) return false;
  if (Date.now() > data.expiresAt) return false;
  return data.code === code.toUpperCase();
}

export async function isUserPairedAsync(userId: number): Promise<boolean> {
  const data = await loadPairingDataAsync();
  if (!data) return false;
  return data.used && data.pairedUserId === userId;
}

export async function isSystemPairedAsync(): Promise<boolean> {
  const data = await loadPairingDataAsync();
  if (!data) return false;
  return data.used;
}
