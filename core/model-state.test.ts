import { describe, expect, it } from "bun:test";
import {
  formatModelChangeNotice,
  reconcileModelNoticeState,
  type PersistedModelNoticeState,
} from "./model-state.ts";

describe("model notice state", () => {
  it("initializes without a pending notice on first boot", () => {
    const state = reconcileModelNoticeState(null, "gpt-4o");

    expect(state).toEqual({
      currentModel: "gpt-4o",
      pendingPreviousModel: null,
      pendingCurrentModel: null,
      pending: false,
      changedAt: null,
      noticedAt: null,
    });
  });

  it("queues a pending notice when the runtime model differs from persisted state", () => {
    const previousState: PersistedModelNoticeState = {
      currentModel: "gpt-4o",
      pendingPreviousModel: null,
      pendingCurrentModel: null,
      pending: false,
      changedAt: null,
      noticedAt: 123,
    };

    const state = reconcileModelNoticeState(previousState, "gpt-4o-mini", 456);

    expect(state).toEqual({
      currentModel: "gpt-4o-mini",
      pendingPreviousModel: "gpt-4o",
      pendingCurrentModel: "gpt-4o-mini",
      pending: true,
      changedAt: 456,
      noticedAt: null,
    });
  });

  it("preserves state when the runtime model is unchanged", () => {
    const currentState: PersistedModelNoticeState = {
      currentModel: "gpt-4o-mini",
      pendingPreviousModel: "gpt-4o",
      pendingCurrentModel: "gpt-4o-mini",
      pending: true,
      changedAt: 456,
      noticedAt: null,
    };

    const state = reconcileModelNoticeState(currentState, "gpt-4o-mini", 999);

    expect(state).toBe(currentState);
  });

  it("formats the one-shot model change notice for injected context", () => {
    const notice = formatModelChangeNotice("gpt-4o", "gpt-4o-mini");

    expect(notice).toContain("<model_change_notice>");
    expect(notice).toContain(
      'the active model changed from "gpt-4o" to "gpt-4o-mini" before this message',
    );
    expect(notice).toContain("this note is only for this turn");
    expect(notice).toContain("</model_change_notice>");
  });
});
