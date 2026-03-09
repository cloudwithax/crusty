import { getDatabase, getAsyncDatabase } from "./db.ts";
import { debug } from "../utils/debug.ts";

// persisted heartbeat config from the database
export interface HeartbeatConfigRecord {
  id: number;
  every: string;
  timezone: string | null;
  days: string | null;
  start_time: string | null;
  end_time: string | null;
  updated_at: number;
}

// input for updating heartbeat config
export interface UpdateHeartbeatConfigInput {
  every?: string;
  timezone?: string | null;
  days?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

// get the current heartbeat config from the database (returns null if no override set)
export async function getHeartbeatConfig(): Promise<HeartbeatConfigRecord | null> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      return await asyncDb.get<HeartbeatConfigRecord>(
        "SELECT * FROM heartbeat_config WHERE id = 1",
      );
    } else {
      const db = getDatabase();
      const query = db.query<HeartbeatConfigRecord>(
        "SELECT * FROM heartbeat_config WHERE id = 1",
      );
      return query.get();
    }
  } catch (error) {
    debug("[heartbeat-config:db] error getting config:", error);
    return null;
  }
}

// save or update the heartbeat config
export async function saveHeartbeatConfig(
  input: UpdateHeartbeatConfigInput,
): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  try {
    // get existing config to merge with updates
    const existing = await getHeartbeatConfig();

    const every = input.every ?? existing?.every ?? "30m";
    const timezone = input.timezone !== undefined ? input.timezone : (existing?.timezone ?? null);
    const days = input.days !== undefined ? input.days : (existing?.days ?? null);
    const startTime = input.startTime !== undefined ? input.startTime : (existing?.start_time ?? null);
    const endTime = input.endTime !== undefined ? input.endTime : (existing?.end_time ?? null);

    if (asyncDb) {
      if (existing) {
        await asyncDb.run(
          `UPDATE heartbeat_config SET
            every = ?, timezone = ?, days = ?, start_time = ?, end_time = ?,
            updated_at = EXTRACT(EPOCH FROM NOW())
          WHERE id = 1`,
          [every, timezone, days, startTime, endTime],
        );
      } else {
        await asyncDb.run(
          `INSERT INTO heartbeat_config (id, every, timezone, days, start_time, end_time)
          VALUES (1, ?, ?, ?, ?, ?)`,
          [every, timezone, days, startTime, endTime],
        );
      }
    } else {
      const db = getDatabase();
      if (existing) {
        db.run(
          `UPDATE heartbeat_config SET
            every = ?, timezone = ?, days = ?, start_time = ?, end_time = ?,
            updated_at = strftime('%s', 'now')
          WHERE id = 1`,
          [every, timezone, days, startTime, endTime],
        );
      } else {
        db.run(
          `INSERT INTO heartbeat_config (id, every, timezone, days, start_time, end_time)
          VALUES (1, ?, ?, ?, ?, ?)`,
          [every, timezone, days, startTime, endTime],
        );
      }
    }

    debug(`[heartbeat-config:db] saved config: every=${every}`);
    return true;
  } catch (error) {
    debug("[heartbeat-config:db] error saving config:", error);
    return false;
  }
}

// delete the heartbeat config override (reverts to env defaults)
export async function deleteHeartbeatConfig(): Promise<boolean> {
  const asyncDb = getAsyncDatabase();

  try {
    if (asyncDb) {
      await asyncDb.run("DELETE FROM heartbeat_config WHERE id = 1");
    } else {
      const db = getDatabase();
      db.run("DELETE FROM heartbeat_config WHERE id = 1");
    }
    debug("[heartbeat-config:db] deleted config override");
    return true;
  } catch (error) {
    debug("[heartbeat-config:db] error deleting config:", error);
    return false;
  }
}
