// single source of truth for the active model at runtime
// kept in a separate module to avoid circular imports between agent and tools

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getAsyncDatabase, getDatabase } from "../data/db.ts";
import { debug } from "../utils/debug.ts";

let activeModel = process.env.OPENAI_MODEL || "gpt-4o";
let modelStateInitialized = false;

export interface PersistedModelNoticeState {
  currentModel: string;
  pendingPreviousModel: string | null;
  pendingCurrentModel: string | null;
  pending: boolean;
  changedAt: number | null;
  noticedAt: number | null;
}

function createInitialModelNoticeState(
  runtimeModel: string,
): PersistedModelNoticeState {
  return {
    currentModel: runtimeModel,
    pendingPreviousModel: null,
    pendingCurrentModel: null,
    pending: false,
    changedAt: null,
    noticedAt: null,
  };
}

export function reconcileModelNoticeState(
  state: PersistedModelNoticeState | null,
  runtimeModel: string,
  now: number = Date.now(),
): PersistedModelNoticeState {
  if (!state) {
    return createInitialModelNoticeState(runtimeModel);
  }

  if (state.currentModel === runtimeModel) {
    return state;
  }

  return {
    currentModel: runtimeModel,
    pendingPreviousModel: state.currentModel,
    pendingCurrentModel: runtimeModel,
    pending: true,
    changedAt: now,
    noticedAt: null,
  };
}

export function formatModelChangeNotice(
  previousModel: string,
  currentModel: string,
): string {
  return [
    "<model_change_notice>",
    `the active model changed from \"${previousModel}\" to \"${currentModel}\" before this message`,
    "this note is only for this turn so adjust for the current model and continue normally",
    "</model_change_notice>",
  ].join("\n");
}

async function ensureModelStateTable(): Promise<void> {
  if (modelStateInitialized) return;

  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    await asyncDb.run(`
      CREATE TABLE IF NOT EXISTS model_runtime_state (
        id BIGINT PRIMARY KEY,
        current_model TEXT NOT NULL,
        pending_previous_model TEXT,
        pending_current_model TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
        changed_at BIGINT,
        noticed_at BIGINT
      )
    `);
  } else {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_model TEXT NOT NULL,
        pending_previous_model TEXT,
        pending_current_model TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
        changed_at INTEGER,
        noticed_at INTEGER
      )
    `);
  }

  modelStateInitialized = true;
}

async function loadPersistedModelNoticeState(): Promise<PersistedModelNoticeState | null> {
  await ensureModelStateTable();

  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    const row = await asyncDb.get<{
      current_model: string;
      pending_previous_model: string | null;
      pending_current_model: string | null;
      pending: number;
      changed_at: number | null;
      noticed_at: number | null;
    }>(
      `SELECT current_model, pending_previous_model, pending_current_model, pending, changed_at, noticed_at FROM model_runtime_state WHERE id = 1`,
    );

    if (!row) return null;

    return {
      currentModel: row.current_model,
      pendingPreviousModel: row.pending_previous_model,
      pendingCurrentModel: row.pending_current_model,
      pending: row.pending === 1,
      changedAt: row.changed_at,
      noticedAt: row.noticed_at,
    };
  }

  const db = getDatabase();
  const row = db
    .query<{
      current_model: string;
      pending_previous_model: string | null;
      pending_current_model: string | null;
      pending: number;
      changed_at: number | null;
      noticed_at: number | null;
    }>(
      `SELECT current_model, pending_previous_model, pending_current_model, pending, changed_at, noticed_at FROM model_runtime_state WHERE id = 1`,
    )
    .get();

  if (!row) return null;

  return {
    currentModel: row.current_model,
    pendingPreviousModel: row.pending_previous_model,
    pendingCurrentModel: row.pending_current_model,
    pending: row.pending === 1,
    changedAt: row.changed_at,
    noticedAt: row.noticed_at,
  };
}

async function savePersistedModelNoticeState(
  state: PersistedModelNoticeState,
): Promise<void> {
  await ensureModelStateTable();

  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    await asyncDb.run(
      `INSERT INTO model_runtime_state (id, current_model, pending_previous_model, pending_current_model, pending, changed_at, noticed_at)
       VALUES (1, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         current_model = EXCLUDED.current_model,
         pending_previous_model = EXCLUDED.pending_previous_model,
         pending_current_model = EXCLUDED.pending_current_model,
         pending = EXCLUDED.pending,
         changed_at = EXCLUDED.changed_at,
         noticed_at = EXCLUDED.noticed_at`,
      [
        state.currentModel,
        state.pendingPreviousModel,
        state.pendingCurrentModel,
        state.pending ? 1 : 0,
        state.changedAt,
        state.noticedAt,
      ],
    );
    return;
  }

  const db = getDatabase();
  db.run(
    `INSERT INTO model_runtime_state (id, current_model, pending_previous_model, pending_current_model, pending, changed_at, noticed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       current_model = excluded.current_model,
       pending_previous_model = excluded.pending_previous_model,
       pending_current_model = excluded.pending_current_model,
       pending = excluded.pending,
       changed_at = excluded.changed_at,
       noticed_at = excluded.noticed_at`,
    [
      1,
      state.currentModel,
      state.pendingPreviousModel,
      state.pendingCurrentModel,
      state.pending ? 1 : 0,
      state.changedAt,
      state.noticedAt,
    ],
  );
}

async function syncPersistedModelNoticeState(): Promise<PersistedModelNoticeState> {
  const currentState = await loadPersistedModelNoticeState();
  const nextState = reconcileModelNoticeState(currentState, getCurrentModel());

  if (!currentState || nextState !== currentState) {
    await savePersistedModelNoticeState(nextState);
  }

  return nextState;
}

export function getCurrentModel(): string {
  return activeModel;
}

export function setCurrentModel(modelId: string): void {
  activeModel = modelId;
}

export interface AppliedModelChange {
  previousModel: string;
  currentModel: string;
  changed: boolean;
}

export async function queueModelChangeNotice(
  previousModel: string,
  currentModel: string,
): Promise<void> {
  if (!previousModel || !currentModel || previousModel === currentModel) {
    return;
  }

  await savePersistedModelNoticeState({
    currentModel,
    pendingPreviousModel: previousModel,
    pendingCurrentModel: currentModel,
    pending: true,
    changedAt: Date.now(),
    noticedAt: null,
  });
}

export async function applyRuntimeModelChange(
  modelId: string,
): Promise<AppliedModelChange> {
  const previousModel = getCurrentModel();

  if (!modelId || previousModel === modelId) {
    return {
      previousModel,
      currentModel: previousModel,
      changed: false,
    };
  }

  setCurrentModel(modelId);
  persistModelToEnv(modelId);
  await queueModelChangeNotice(previousModel, modelId);

  return {
    previousModel,
    currentModel: modelId,
    changed: true,
  };
}

export async function consumePendingModelChangeNotice(): Promise<
  string | null
> {
  const state = await syncPersistedModelNoticeState();

  if (
    !state.pending ||
    !state.pendingPreviousModel ||
    !state.pendingCurrentModel
  ) {
    return null;
  }

  const notice = formatModelChangeNotice(
    state.pendingPreviousModel,
    state.pendingCurrentModel,
  );

  await savePersistedModelNoticeState({
    currentModel: state.currentModel,
    pendingPreviousModel: null,
    pendingCurrentModel: null,
    pending: false,
    changedAt: state.changedAt,
    noticedAt: Date.now(),
  });

  return notice;
}

// persist the model choice to .env so it survives restarts
export function persistModelToEnv(modelId: string): void {
  const envPath = join(import.meta.dirname || process.cwd(), "..", ".env");
  try {
    const content = readFileSync(envPath, "utf-8");
    const updated = content.replace(
      /^OPENAI_MODEL=.*$/m,
      `OPENAI_MODEL=${modelId}`,
    );

    if (updated === content && !content.includes("OPENAI_MODEL=")) {
      // key doesnt exist yet, append it
      writeFileSync(envPath, content.trimEnd() + `\nOPENAI_MODEL=${modelId}\n`);
    } else {
      writeFileSync(envPath, updated);
    }

    // sync process.env so getCurrentModel reflects the env default correctly
    process.env.OPENAI_MODEL = modelId;
    debug(`[model-state] persisted model "${modelId}" to .env`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    debug(`[model-state] failed to persist model to .env: ${msg}`);
  }
}
