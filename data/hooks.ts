import { getDatabase, getAsyncDatabase, isUsingPostgres } from "./db.ts";
import { debug } from "../utils/debug.ts";

// source type for tracking how a hook was added
export type HookSourceType = "filesystem" | "wizard" | "url" | "imported";

// database hook record
export interface HookRecord {
  id: number;
  name: string;
  description: string | null;
  content: string;
  every: string;
  enabled: number;
  timeout: string | null;
  timezone: string | null;
  days: string | null;
  start_time: string | null;
  end_time: string | null;
  source_type: HookSourceType;
  source_url: string | null;
  created_at: number;
  updated_at: number;
}

// input for creating a new hook
export interface CreateHookInput {
  name: string;
  description?: string;
  content: string;
  every: string;
  enabled?: boolean;
  timeout?: string;
  timezone?: string;
  days?: string;
  startTime?: string;
  endTime?: string;
  sourceType: HookSourceType;
  sourceUrl?: string;
}

// save a hook to the database
export async function saveHook(input: CreateHookInput): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      // postgres async path
      const existing = await asyncDb.get<{ id: number }>(
        "SELECT id FROM hooks WHERE name = ?",
        input.name,
      );

      if (existing) {
        // update existing hook
        await asyncDb.run(
          `UPDATE hooks SET
            description = ?,
            content = ?,
            every = ?,
            enabled = ?,
            timeout = ?,
            timezone = ?,
            days = ?,
            start_time = ?,
            end_time = ?,
            source_type = ?,
            source_url = ?,
            updated_at = EXTRACT(EPOCH FROM NOW())
          WHERE name = ?`,
          [
            input.description || null,
            input.content,
            input.every,
            input.enabled !== false ? 1 : 0,
            input.timeout || null,
            input.timezone || null,
            input.days || null,
            input.startTime || null,
            input.endTime || null,
            input.sourceType,
            input.sourceUrl || null,
            input.name,
          ],
        );
        debug(`[hooks:db] updated hook: ${input.name}`);
      } else {
        // insert new hook
        await asyncDb.run(
          `INSERT INTO hooks (name, description, content, every, enabled, timeout, timezone, days, start_time, end_time, source_type, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.name,
            input.description || null,
            input.content,
            input.every,
            input.enabled !== false ? 1 : 0,
            input.timeout || null,
            input.timezone || null,
            input.days || null,
            input.startTime || null,
            input.endTime || null,
            input.sourceType,
            input.sourceUrl || null,
          ],
        );
        debug(`[hooks:db] saved new hook: ${input.name}`);
      }
    } else {
      // sqlite sync path
      const db = getDatabase();
      const existingQuery = db.query<{ id: number }>(
        "SELECT id FROM hooks WHERE name = ?",
      );
      const existing = existingQuery.get(input.name);

      if (existing) {
        db.run(
          `UPDATE hooks SET
            description = ?,
            content = ?,
            every = ?,
            enabled = ?,
            timeout = ?,
            timezone = ?,
            days = ?,
            start_time = ?,
            end_time = ?,
            source_type = ?,
            source_url = ?,
            updated_at = strftime('%s', 'now')
          WHERE name = ?`,
          [
            input.description || null,
            input.content,
            input.every,
            input.enabled !== false ? 1 : 0,
            input.timeout || null,
            input.timezone || null,
            input.days || null,
            input.startTime || null,
            input.endTime || null,
            input.sourceType,
            input.sourceUrl || null,
            input.name,
          ],
        );
        debug(`[hooks:db] updated hook: ${input.name}`);
      } else {
        db.run(
          `INSERT INTO hooks (name, description, content, every, enabled, timeout, timezone, days, start_time, end_time, source_type, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.name,
            input.description || null,
            input.content,
            input.every,
            input.enabled !== false ? 1 : 0,
            input.timeout || null,
            input.timezone || null,
            input.days || null,
            input.startTime || null,
            input.endTime || null,
            input.sourceType,
            input.sourceUrl || null,
          ],
        );
        debug(`[hooks:db] saved new hook: ${input.name}`);
      }
    }

    return true;
  } catch (error) {
    debug(`[hooks:db] error saving hook ${input.name}:`, error);
    return false;
  }
}

// load all hooks from the database
export async function loadAllHooks(): Promise<HookRecord[]> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      const hooks = await asyncDb.all<HookRecord>(
        "SELECT * FROM hooks ORDER BY name",
      );
      debug(`[hooks:db] loaded ${hooks.length} hook(s) from postgres`);
      return hooks;
    } else {
      const db = getDatabase();
      const query = db.query<HookRecord>("SELECT * FROM hooks ORDER BY name");
      const hooks = query.all();
      debug(`[hooks:db] loaded ${hooks.length} hook(s) from sqlite`);
      return hooks;
    }
  } catch (error) {
    debug("[hooks:db] error loading hooks:", error);
    return [];
  }
}

// get a single hook by name
export async function getHookByName(name: string): Promise<HookRecord | null> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      return await asyncDb.get<HookRecord>(
        "SELECT * FROM hooks WHERE name = ?",
        name,
      );
    } else {
      const db = getDatabase();
      const query = db.query<HookRecord>("SELECT * FROM hooks WHERE name = ?");
      return query.get(name);
    }
  } catch (error) {
    debug(`[hooks:db] error getting hook ${name}:`, error);
    return null;
  }
}

// delete a hook from the database
export async function deleteHook(name: string): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      await asyncDb.run("DELETE FROM hooks WHERE name = ?", [name]);
    } else {
      const db = getDatabase();
      db.run("DELETE FROM hooks WHERE name = ?", [name]);
    }
    debug(`[hooks:db] deleted hook: ${name}`);
    return true;
  } catch (error) {
    debug(`[hooks:db] error deleting hook ${name}:`, error);
    return false;
  }
}

// update hook enabled status
export async function updateHookEnabled(
  name: string,
  enabled: boolean,
): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      await asyncDb.run(
        "UPDATE hooks SET enabled = ?, updated_at = EXTRACT(EPOCH FROM NOW()) WHERE name = ?",
        [enabled ? 1 : 0, name],
      );
    } else {
      const db = getDatabase();
      db.run(
        "UPDATE hooks SET enabled = ?, updated_at = strftime('%s', 'now') WHERE name = ?",
        [enabled ? 1 : 0, name],
      );
    }
    debug(`[hooks:db] updated hook ${name} enabled=${enabled}`);
    return true;
  } catch (error) {
    debug(`[hooks:db] error updating hook ${name}:`, error);
    return false;
  }
}
