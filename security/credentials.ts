import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from "node:crypto";
import { getDatabase, getAsyncDatabase } from "../data/db.ts";
import { debug } from "../utils/debug.ts";

export type CredentialScope = "app" | "skill";

export interface CredentialMetadata {
  scope: CredentialScope;
  owner: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
}

export interface RetrievedCredential extends CredentialMetadata {
  value: string;
}

const MASTER_KEY_ENV = "CRUSTY_CREDENTIALS_MASTER_KEY";
const ENCRYPTION_ALGO = "aes-256-gcm";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

type DbCredentialRow = {
  scope: CredentialScope;
  owner: string;
  name: string;
  encrypted_value: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
};

type EncryptedPayload = {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class CredentialsStore {
  private initialized = false;

  private ensureReady(): void {
    if (this.initialized) return;
    this.initialized = true;
    debug("[credentials] service initialized");
  }

  isAvailable(): { ok: boolean; reason?: string } {
    const masterKey = this.getMasterKey();
    if (!masterKey) {
      return {
        ok: false,
        reason: `${MASTER_KEY_ENV} is not set`,
      };
    }

    if (masterKey.length < 16) {
      return {
        ok: false,
        reason: `${MASTER_KEY_ENV} must be at least 16 characters`,
      };
    }

    return { ok: true };
  }

  async upsertCredential(
    userId: number,
    scope: CredentialScope,
    owner: string,
    name: string,
    value: string,
    description?: string,
  ): Promise<CredentialMetadata> {
    this.ensureReady();

    const normalized = this.normalize(scope, owner, name);
    const masterKey = this.requireMasterKey();
    const now = Date.now();
    const encryptedValue = this.encryptValue(value, masterKey);

    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run(
        `INSERT INTO credentials (user_id, scope, owner, name, encrypted_value, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, scope, owner, name)
         DO UPDATE SET
           encrypted_value = EXCLUDED.encrypted_value,
           description = EXCLUDED.description,
           updated_at = EXCLUDED.updated_at`,
        [
          userId,
          normalized.scope,
          normalized.owner,
          normalized.name,
          encryptedValue,
          description || null,
          now,
          now,
        ],
      );
    } else {
      const db = getDatabase();
      db.run(
        `INSERT INTO credentials (user_id, scope, owner, name, encrypted_value, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, scope, owner, name)
         DO UPDATE SET
           encrypted_value = excluded.encrypted_value,
           description = excluded.description,
           updated_at = excluded.updated_at`,
        [
          userId,
          normalized.scope,
          normalized.owner,
          normalized.name,
          encryptedValue,
          description || null,
          now,
          now,
        ],
      );
    }

    const latest = await this.getCredentialMetadata(
      userId,
      normalized.scope,
      normalized.owner,
      normalized.name,
    );

    if (!latest) {
      throw new Error("failed to store credential");
    }

    debug(
      `[credentials] stored ${normalized.scope}/${normalized.owner}/${normalized.name} for user ${userId}`,
    );

    return latest;
  }

  async getCredential(
    userId: number,
    scope: CredentialScope,
    owner: string,
    name: string,
  ): Promise<RetrievedCredential | null> {
    this.ensureReady();

    const normalized = this.normalize(scope, owner, name);
    const row = await this.getCredentialRow(
      userId,
      normalized.scope,
      normalized.owner,
      normalized.name,
    );

    if (!row) {
      return null;
    }

    const masterKey = this.requireMasterKey();
    const value = this.decryptValue(row.encrypted_value, masterKey);
    const now = Date.now();

    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run(
        `UPDATE credentials
         SET last_accessed_at = $1
         WHERE user_id = $2 AND scope = $3 AND owner = $4 AND name = $5`,
        [now, userId, normalized.scope, normalized.owner, normalized.name],
      );
    } else {
      const db = getDatabase();
      db.run(
        `UPDATE credentials
         SET last_accessed_at = ?
         WHERE user_id = ? AND scope = ? AND owner = ? AND name = ?`,
        [now, userId, normalized.scope, normalized.owner, normalized.name],
      );
    }

    return {
      scope: row.scope,
      owner: row.owner,
      name: row.name,
      description: row.description || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastAccessedAt: now,
      value,
    };
  }

  async deleteCredential(
    userId: number,
    scope: CredentialScope,
    owner: string,
    name: string,
  ): Promise<boolean> {
    this.ensureReady();

    const normalized = this.normalize(scope, owner, name);
    const existing = await this.getCredentialMetadata(
      userId,
      normalized.scope,
      normalized.owner,
      normalized.name,
    );
    if (!existing) {
      return false;
    }

    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      await asyncDb.run(
        `DELETE FROM credentials
         WHERE user_id = $1 AND scope = $2 AND owner = $3 AND name = $4`,
        [userId, normalized.scope, normalized.owner, normalized.name],
      );
    } else {
      const db = getDatabase();
      db.run(
        `DELETE FROM credentials
         WHERE user_id = ? AND scope = ? AND owner = ? AND name = ?`,
        [userId, normalized.scope, normalized.owner, normalized.name],
      );
    }

    debug(
      `[credentials] deleted ${normalized.scope}/${normalized.owner}/${normalized.name} for user ${userId}`,
    );

    return true;
  }

  async listCredentials(
    userId: number,
    filters?: {
      scope?: CredentialScope;
      owner?: string;
      limit?: number;
    },
  ): Promise<CredentialMetadata[]> {
    this.ensureReady();

    const scope = filters?.scope;
    const owner = filters?.owner?.trim();
    const limit = Math.max(1, Math.min(filters?.limit ?? 50, 200));

    const clauses = ["user_id = ?"];
    const sqliteParams: unknown[] = [userId];
    const pgClauses = ["user_id = $1"];
    const pgParams: unknown[] = [userId];

    if (scope) {
      sqliteParams.push(scope);
      clauses.push("scope = ?");
      pgParams.push(scope);
      pgClauses.push(`scope = $${pgParams.length}`);
    }

    if (owner) {
      sqliteParams.push(owner);
      clauses.push("owner = ?");
      pgParams.push(owner);
      pgClauses.push(`owner = $${pgParams.length}`);
    }

    const asyncDb = getAsyncDatabase();
    let rows: DbCredentialRow[] = [];

    if (asyncDb) {
      pgParams.push(limit);
      rows = await asyncDb.all<DbCredentialRow>(
        `SELECT scope, owner, name, encrypted_value, description, created_at, updated_at, last_accessed_at
         FROM credentials
         WHERE ${pgClauses.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT $${pgParams.length}`,
        ...pgParams,
      );
    } else {
      const db = getDatabase();
      sqliteParams.push(limit);
      rows = db
        .query<DbCredentialRow>(
          `SELECT scope, owner, name, encrypted_value, description, created_at, updated_at, last_accessed_at
           FROM credentials
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(...sqliteParams);
    }

    return rows.map((row) => ({
      scope: row.scope,
      owner: row.owner,
      name: row.name,
      description: row.description || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastAccessedAt:
        row.last_accessed_at === null
          ? undefined
          : Number(row.last_accessed_at),
    }));
  }

  private async getCredentialMetadata(
    userId: number,
    scope: CredentialScope,
    owner: string,
    name: string,
  ): Promise<CredentialMetadata | null> {
    const row = await this.getCredentialRow(userId, scope, owner, name);
    if (!row) return null;

    return {
      scope: row.scope,
      owner: row.owner,
      name: row.name,
      description: row.description || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastAccessedAt:
        row.last_accessed_at === null
          ? undefined
          : Number(row.last_accessed_at),
    };
  }

  private async getCredentialRow(
    userId: number,
    scope: CredentialScope,
    owner: string,
    name: string,
  ): Promise<DbCredentialRow | null> {
    const asyncDb = getAsyncDatabase();

    if (asyncDb) {
      return await asyncDb.get<DbCredentialRow>(
        `SELECT scope, owner, name, encrypted_value, description, created_at, updated_at, last_accessed_at
         FROM credentials
         WHERE user_id = $1 AND scope = $2 AND owner = $3 AND name = $4`,
        userId,
        scope,
        owner,
        name,
      );
    }

    const db = getDatabase();
    return db
      .query<DbCredentialRow>(
        `SELECT scope, owner, name, encrypted_value, description, created_at, updated_at, last_accessed_at
         FROM credentials
         WHERE user_id = ? AND scope = ? AND owner = ? AND name = ?`,
      )
      .get(userId, scope, owner, name);
  }

  private normalize(
    scope: CredentialScope,
    owner: string,
    name: string,
  ): {
    scope: CredentialScope;
    owner: string;
    name: string;
  } {
    const normalizedOwner = owner.trim();
    const normalizedName = name.trim();

    if (!normalizedOwner) {
      throw new Error("owner is required");
    }

    if (!normalizedName) {
      throw new Error("name is required");
    }

    return {
      scope,
      owner: normalizedOwner,
      name: normalizedName,
    };
  }

  private getMasterKey(): string | null {
    const key = process.env[MASTER_KEY_ENV]?.trim();
    return key ? key : null;
  }

  private requireMasterKey(): string {
    const status = this.isAvailable();
    if (!status.ok) {
      throw new Error(
        `credentials store is unavailable: ${status.reason || "missing master key"}`,
      );
    }

    return this.getMasterKey()!;
  }

  private encryptValue(value: string, masterKey: string): string {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = scryptSync(masterKey, salt, KEY_BYTES);

    const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };

    return JSON.stringify(payload);
  }

  private decryptValue(encryptedPayload: string, masterKey: string): string {
    let payload: EncryptedPayload;
    try {
      payload = JSON.parse(encryptedPayload) as EncryptedPayload;
    } catch {
      throw new Error("credential payload is corrupted");
    }

    if (
      payload.v !== 1 ||
      !payload.salt ||
      !payload.iv ||
      !payload.tag ||
      !payload.ciphertext
    ) {
      throw new Error("credential payload is invalid");
    }

    const salt = Buffer.from(payload.salt, "base64");
    const iv = Buffer.from(payload.iv, "base64");
    const authTag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");
    const key = scryptSync(masterKey, salt, KEY_BYTES);

    const decipher = createDecipheriv(ENCRYPTION_ALGO, key, iv);
    decipher.setAuthTag(authTag);

    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    } catch {
      throw new Error(
        "failed to decrypt credential check CRUSTY_CREDENTIALS_MASTER_KEY",
      );
    }
  }
}

export const credentialsStore = new CredentialsStore();
