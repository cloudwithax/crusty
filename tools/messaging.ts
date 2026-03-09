import { z } from "zod";
import { debug } from "../utils/debug.ts";
import {
  getCurrentModel,
  setCurrentModel,
  persistModelToEnv,
} from "../core/model-state.ts";

// bridge for delivering messages to paired users across all channels
// set by index.ts on startup so tools can send messages without depending on specific bot implementations
let messageSender: ((text: string, isHook?: boolean) => Promise<void>) | null =
  null;

// set by index.ts after bot startup
export function setMessagingSender(
  sender: (text: string, isHook?: boolean) => Promise<void>,
): void {
  messageSender = sender;
}

const sendMessageSchema = z.object({
  message: z.string().describe("the message text to send to the user"),
});

const setModelSchema = z.object({
  model: z
    .string()
    .describe(
      "the model name to switch to (e.g. gpt-4o, gpt-4o-mini, o1-preview). this takes effect for all subsequent agent calls until changed again.",
    ),
});

const getModelSchema = z.object({});

async function handleSendMessage(
  args: z.infer<typeof sendMessageSchema>,
): Promise<string> {
  if (!messageSender) {
    debug("[messaging] no message sender configured, cannot deliver message");
    return "[Error] No message sender configured. Cannot deliver message.";
  }

  if (!args.message?.trim()) {
    return "[Error] Message cannot be empty.";
  }

  try {
    await messageSender(args.message, true);
    debug(`[messaging] delivered message: ${args.message.substring(0, 80)}`);
    return "Message delivered successfully.";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    debug(`[messaging] failed to deliver message: ${msg}`);
    return `[Error] Failed to deliver message: ${msg}`;
  }
}

async function handleSetModel(
  args: z.infer<typeof setModelSchema>,
): Promise<string> {
  const model = args.model?.trim();
  if (!model) {
    return "[Error] Model name cannot be empty.";
  }

  const previous = getCurrentModel();
  setCurrentModel(model);
  persistModelToEnv(model);
  debug(`[messaging] model switched from ${previous} to ${model}`);
  return `Model switched from "${previous}" to "${model}". This will take effect on the next agent call.`;
}

async function handleGetModel(): Promise<string> {
  const current = getCurrentModel();
  const envDefault = process.env.OPENAI_MODEL || "gpt-4o";
  if (current !== envDefault) {
    return `Active model: "${current}" (runtime override, env default is "${envDefault}")`;
  }
  return `Active model: "${current}" (from environment)`;
}

export const messagingTools = {
  send_message: {
    description: `Send a message to the user across all paired channels (Telegram, iMessage, etc). Use this when a hook or automated process needs to proactively notify the user without waiting for them to ask. The message is delivered immediately.

WHEN TO USE:
- Hook needs to alert user about something (price change, weather, event, etc.)
- Automated task completed and user should be informed
- Something important was detected and warrants immediate notification

PARAMETERS:
- message (required): The text to deliver to the user`,
    schema: sendMessageSchema,
    handler: handleSendMessage,
  },

  set_model: {
    description: `Switch the active language model at runtime. This lets hooks or the agent itself change which model is used for subsequent responses without restarting the bot.

WHEN TO USE:
- User asks to switch to a faster/cheaper/more powerful model
- A hook needs to temporarily use a different model for specific tasks
- Switching between reasoning and non-reasoning models based on task complexity

PARAMETERS:
- model (required): Model identifier (e.g. "gpt-4o", "gpt-4o-mini", "o1-preview", "o3-mini")

NOTE: The override persists until changed again or the bot restarts.`,
    schema: setModelSchema,
    handler: handleSetModel,
  },

  get_model: {
    description: `Get the currently active language model. Shows whether a runtime override is in effect or the environment default is being used.`,
    schema: getModelSchema,
    handler: handleGetModel,
  },
};
