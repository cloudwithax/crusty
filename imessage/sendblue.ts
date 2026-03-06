// sendblue api client for imessage integration
// handles all communication with the sendblue rest api

import { debug } from "../utils/debug.ts";

const SENDBLUE_API_BASE = "https://api.sendblue.co/api";

interface SendBlueConfig {
  apiKey: string;
  apiSecret: string;
  fromNumber?: string;
}

interface SendMessageParams {
  to: string;
  content?: string;
  mediaUrl?: string;
  statusCallback?: string;
  sendStyle?: string;
}

interface SendMessageResponse {
  status: string;
  message_handle: string;
  error_code?: number;
  error_message?: string;
}

interface TypingIndicatorResponse {
  status: string;
  status_code: number;
  error_message?: string;
  number: string;
}

interface WebhookConfig {
  receive?: string[];
  outbound?: string[];
  typing_indicator?: string[];
  globalSecret?: string;
}

interface WebhookListResponse {
  status: string;
  webhooks: {
    receive: (string | { url: string; secret?: string })[];
    outbound: (string | { url: string; secret?: string })[];
    typing_indicator: (string | { url: string; secret?: string })[];
    call_log: (string | { url: string; secret?: string })[];
    line_blocked: (string | { url: string; secret?: string })[];
    line_assigned: (string | { url: string; secret?: string })[];
    contact_created: string[];
    globalSecret?: string;
  };
}

// inbound message webhook payload from sendblue
export interface InboundMessage {
  accountEmail: string;
  content: string;
  is_outbound: boolean;
  status: string;
  error_code: number | null;
  error_message: string | null;
  error_reason: string | null;
  message_handle: string;
  date_sent: string;
  date_updated: string;
  from_number: string;
  number: string;
  to_number: string;
  was_downgraded: boolean | null;
  plan: string;
  media_url: string;
  message_type: string;
  group_id: string;
  participants: string[];
  send_style: string;
  opted_out: boolean;
  error_detail: string | null;
  sendblue_number: string;
  service: string;
  group_display_name: string | null;
}

export class SendBlueClient {
  private config: SendBlueConfig;

  constructor(config: SendBlueConfig) {
    this.config = config;
  }

  private get headers(): Record<string, string> {
    return {
      "sb-api-key-id": this.config.apiKey,
      "sb-api-secret-key": this.config.apiSecret,
      "Content-Type": "application/json",
    };
  }

  // send an imessage to a phone number
  async sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    const body: Record<string, string> = {
      number: params.to,
    };

    if (this.config.fromNumber) {
      body.from_number = this.config.fromNumber;
    }

    if (params.content) {
      body.content = params.content;
    }

    if (params.mediaUrl) {
      body.media_url = params.mediaUrl;
    }

    if (params.statusCallback) {
      body.status_callback = params.statusCallback;
    }

    if (params.sendStyle) {
      body.send_style = params.sendStyle;
    }

    const response = await fetch(`${SENDBLUE_API_BASE}/send-message`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `sendblue send-message failed: ${response.status} ${text}`,
      );
    }

    return response.json() as Promise<SendMessageResponse>;
  }

  // send typing indicator to show the bot is composing
  async sendTypingIndicator(
    toNumber: string,
  ): Promise<TypingIndicatorResponse> {
    const body: Record<string, string> = {
      number: toNumber,
    };

    if (this.config.fromNumber) {
      body.from_number = this.config.fromNumber;
    }

    const response = await fetch(`${SENDBLUE_API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      debug(`[sendblue] typing indicator failed: ${response.status} ${text}`);
      // dont throw on typing indicator failure, its non-critical
      return {
        status: "ERROR",
        status_code: response.status,
        error_message: text,
        number: toNumber,
      };
    }

    return response.json() as Promise<TypingIndicatorResponse>;
  }

  // list currently configured webhooks
  async listWebhooks(): Promise<WebhookListResponse> {
    const response = await fetch(`${SENDBLUE_API_BASE}/account/webhooks`, {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `sendblue list-webhooks failed: ${response.status} ${text}`,
      );
    }

    return response.json() as Promise<WebhookListResponse>;
  }

  // replace all webhooks with the provided configuration
  async setWebhooks(config: WebhookConfig): Promise<void> {
    const webhooks: Record<string, unknown> = {};

    if (config.receive) webhooks.receive = config.receive;
    if (config.outbound) webhooks.outbound = config.outbound;
    if (config.typing_indicator)
      webhooks.typing_indicator = config.typing_indicator;
    if (config.globalSecret) webhooks.globalSecret = config.globalSecret;

    const response = await fetch(`${SENDBLUE_API_BASE}/account/webhooks`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({ webhooks }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `sendblue set-webhooks failed: ${response.status} ${text}`,
      );
    }

    debug("[sendblue] webhooks updated");
  }

  // add a receive webhook without replacing existing ones
  async addReceiveWebhook(url: string): Promise<void> {
    const response = await fetch(`${SENDBLUE_API_BASE}/account/webhooks`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        webhooks: [url],
        type: "receive",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `sendblue add-webhook failed: ${response.status} ${text}`,
      );
    }

    debug(`[sendblue] receive webhook added: ${url}`);
  }
}
