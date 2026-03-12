import { conversationThreadStore } from "./thread-store.ts";
import {
  type ConversationPlatform,
  shouldReuseActiveThread,
} from "./conversation-threading.ts";

type ThreadRouteDecision =
  | { kind: "existing"; threadId: string; reason: string }
  | { kind: "new"; reason: string };

export async function chooseThread(
  platform: ConversationPlatform,
  userId: number,
): Promise<ThreadRouteDecision> {
  const latestThread = await conversationThreadStore().getLatestThread(
    platform,
    userId,
  );
  if (!latestThread) {
    return { kind: "new", reason: "no prior thread" };
  }

  if (shouldReuseActiveThread(latestThread.updatedAt)) {
    return {
      kind: "existing",
      threadId: latestThread.threadId,
      reason: "active thread still within reuse window",
    };
  }

  return { kind: "new", reason: "latest thread is outside reuse window" };
}
