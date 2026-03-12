import { spawn } from "child_process";
import { readFileSync } from "fs";
import { z } from "zod";
import { getAsyncDatabase, getDatabase } from "../data/db.ts";
import { getDefaultWorkspace } from "../core/workspace.ts";
import {
  clearDynamicTools,
  registerDynamicTools,
  type ToolDefinition,
} from "./runtime-tools.ts";
import { debug } from "../utils/debug.ts";

const ACP_DYNAMIC_TOOL_PREFIX = "acp_";
const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 750;
const DEFAULT_PROMPT_TIMEOUT_MS = 30_000;
const DEFAULT_DISCOVERY_PATHS = ["/acp", "/api/acp", "/rpc/acp", "/agent/acp"];
const DEFAULT_DISCOVERY_HOSTS = ["127.0.0.1", "localhost"];
const ACP_CLIENT_INFO = {
  name: "crusty",
  title: "Crusty",
  version: "1.0.0",
};

const DEFAULT_BUN_STDIO_PROXY_ENABLED = true;

type AcpTransport = "http" | "stdio";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: Record<string, unknown> | null;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  method?: string;
  params?: Record<string, unknown>;
}

interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  authMethods?: unknown[];
}

interface AcpServerRecord {
  transport: AcpTransport;
  endpoint: string;
  toolName: string;
  host: string;
  port: number;
  path: string;
  protocolVersion: number;
  agentName: string;
  agentTitle: string | null;
  agentVersion: string | null;
  capabilitiesJson: string;
  authMethodsJson: string;
  metadataJson: string;
  firstSeenAt: number;
  lastSeenAt: number;
  active: number;
}

interface AcpSessionCacheEntry {
  sessionId: string;
  endpoint: string;
  cwd: string;
}

interface DiscoveryStateRow {
  bootstrapped: number;
  last_scan_at: number | null;
  last_scan_mode: string | null;
}

interface PortHint {
  host: string;
  port: number;
  path: string;
}

interface StdioRegistryEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  toolName?: string;
}

interface StdioPendingRequest {
  id: number;
  resolve: (messages: JsonRpcResponse[]) => void;
  reject: (error: Error) => void;
  messages: JsonRpcResponse[];
  timer: ReturnType<typeof setTimeout>;
}

interface StdioTransportHandle {
  sendRequest: (
    request: JsonRpcRequest,
    timeoutMs: number,
  ) => Promise<JsonRpcResponse[]>;
  close: () => Promise<void>;
}

interface BunStdioProcess {
  stdin: {
    write: (chunk: string | Uint8Array) => number | Promise<number>;
    flush: () => number | Promise<number>;
    end: (chunk?: string | Uint8Array) => number | Promise<number>;
  };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: (signal?: string | number) => void;
  exited: Promise<number>;
}

const ACP_BUN_STDIO_NODE_WRAPPER = [
  'const { spawn } = require("child_process");',
  "const [command, ...args] = process.argv.slice(1);",
  'const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });',
  "process.stdin.pipe(child.stdin);",
  "child.stdout.pipe(process.stdout);",
  "child.stderr.pipe(process.stderr);",
  'child.on("error", (error) => { console.error(error.message); process.exit(1); });',
  'child.on("exit", (code, signal) => {',
  "  if (signal) { process.kill(process.pid, signal); return; }",
  "  process.exit(code ?? 0);",
  "});",
].join(" ");

const stdioRegistryEntrySchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  toolName: z.string().optional(),
});

const rediscoverAcpSchema = z.object({
  http: z
    .boolean()
    .optional()
    .describe("rediscover ACP agents exposed over HTTP"),
  stdio: z
    .boolean()
    .optional()
    .describe("rediscover configured stdio ACP agents"),
});

const listAcpAgentsSchema = z.object({});

const sessionCache = new Map<string, AcpSessionCacheEntry>();
let nextRequestId = 1;

export const acpTools: Record<string, ToolDefinition> = {
  rediscover_acp_agents: {
    description:
      "manually rescan ACP agents and refresh the runtime ACP tools exposed to the agent. supports both HTTP discovery and configured stdio ACP binaries.",
    schema: rediscoverAcpSchema,
    handler: async (args: z.infer<typeof rediscoverAcpSchema>) => {
      const records = await rediscoverAcpAgents({
        http: args.http ?? true,
        stdio: args.stdio ?? true,
        reason: "manual_tool",
      });

      if (records.length === 0) {
        return "No ACP agents discovered.";
      }

      return records.map((record) => getAcpServerSummary(record)).join("\n");
    },
  },
  list_acp_agents: {
    description:
      "list active ACP agents currently exposed as runtime tools, including transport type and endpoint or launcher details.",
    schema: listAcpAgentsSchema,
    handler: async () => {
      const records = await loadPersistedServers();
      if (records.length === 0) {
        return "No ACP agents are active.";
      }

      return records.map((record) => getAcpServerSummary(record)).join("\n");
    },
  },
};

function getDiscoveryTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.ACP_DISCOVERY_TIMEOUT_MS || "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DISCOVERY_TIMEOUT_MS;
  }

  return parsed;
}

function getPromptTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.ACP_PROMPT_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROMPT_TIMEOUT_MS;
  }

  return parsed;
}

function getBunStdioProxyEnabled(): boolean {
  const raw = process.env.ACP_BUN_STDIO_PROXY?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_BUN_STDIO_PROXY_ENABLED;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  return DEFAULT_BUN_STDIO_PROXY_ENABLED;
}

function getDiscoveryPaths(): string[] {
  const raw = process.env.ACP_DISCOVERY_PATHS?.trim();
  if (!raw) {
    return DEFAULT_DISCOVERY_PATHS;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => (value.startsWith("/") ? value : `/${value}`));
}

function readDefaultGateway(): string | null {
  try {
    const content = readFileSync("/proc/net/route", "utf-8");
    const lines = content.trim().split("\n").slice(1);

    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 3) {
        continue;
      }

      const destination = fields[1];
      const gateway = fields[2];
      if (destination !== "00000000" || !gateway) {
        continue;
      }

      const bytes = gateway.match(/.{2}/g);
      if (!bytes || bytes.length !== 4) {
        continue;
      }

      return bytes
        .map((value) => Number.parseInt(value, 16))
        .reverse()
        .join(".");
    }
  } catch {
    return null;
  }

  return null;
}

function getDiscoveryHosts(): string[] {
  const hosts = new Set<string>();
  const configured = process.env.ACP_DISCOVERY_HOSTS?.trim();

  if (configured) {
    for (const value of configured.split(",")) {
      const host = value.trim();
      if (host) {
        hosts.add(host);
      }
    }
  } else {
    for (const host of DEFAULT_DISCOVERY_HOSTS) {
      hosts.add(host);
    }
  }

  if (process.env.CRUSTY_DOCKER === "true") {
    hosts.add("host.docker.internal");
    const gateway = readDefaultGateway();
    if (gateway) {
      hosts.add(gateway);
    }
  }

  return [...hosts];
}

function readListeningPortsFromProc(filePath: string): number[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").slice(1);
    const ports = new Set<number>();

    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const localAddress = fields[1];
      const state = fields[3];
      if (!localAddress || state !== "0A") {
        continue;
      }

      const parts = localAddress.split(":");
      const portHex = parts[1];
      if (!portHex) {
        continue;
      }

      const port = Number.parseInt(portHex, 16);
      if (Number.isFinite(port) && port > 0) {
        ports.add(port);
      }
    }

    return [...ports];
  } catch {
    return [];
  }
}

export function getListeningTcpPorts(): number[] {
  const ports = new Set<number>([
    ...readListeningPortsFromProc("/proc/net/tcp"),
    ...readListeningPortsFromProc("/proc/net/tcp6"),
  ]);

  return [...ports].sort((left, right) => left - right);
}

function getDiscoveryPorts(): number[] {
  const ports = new Set<number>(getListeningTcpPorts());
  const configured = process.env.ACP_DISCOVERY_PORTS?.trim();

  if (!configured) {
    return [...ports].sort((left, right) => left - right);
  }

  for (const value of configured.split(",")) {
    const port = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }

  return [...ports].sort((left, right) => left - right);
}

function sanitizeToolSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function buildAcpToolName(
  baseName: string,
  existingNames: Set<string>,
): string {
  const normalized = sanitizeToolSlug(baseName) || "server";
  let candidate = `${ACP_DYNAMIC_TOOL_PREFIX}${normalized}`;

  if (!existingNames.has(candidate)) {
    existingNames.add(candidate);
    return candidate;
  }

  let suffix = 2;
  while (existingNames.has(`${candidate}_${suffix}`)) {
    suffix += 1;
  }

  const unique = `${candidate}_${suffix}`;
  existingNames.add(unique);
  return unique;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseAcpStdioRegistryEntries(raw: string): StdioRegistryEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return z.array(stdioRegistryEntrySchema).parse(parsed);
  } catch (error) {
    debug(
      `[acp] failed to parse ACP stdio registry: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

export function parseAcpStdioRegistry(raw: string): StdioRegistryEntry[] {
  return parseAcpStdioRegistryEntries(raw);
}

function loadConfiguredStdioEntries(): StdioRegistryEntry[] {
  const entries: StdioRegistryEntry[] = [];
  const rawJson = process.env.ACP_STDIO_AGENTS_JSON?.trim();
  if (rawJson) {
    entries.push(...parseAcpStdioRegistryEntries(rawJson));
  }

  const registryFile = process.env.ACP_STDIO_AGENTS_FILE?.trim();
  if (registryFile) {
    try {
      entries.push(
        ...parseAcpStdioRegistryEntries(readFileSync(registryFile, "utf-8")),
      );
    } catch (error) {
      debug(
        `[acp] failed to read ACP stdio registry file ${registryFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const uniqueByName = new Map<string, StdioRegistryEntry>();
  for (const entry of entries) {
    uniqueByName.set(entry.name, entry);
  }

  return [...uniqueByName.values()];
}

function hasConfiguredStdioRegistry(): boolean {
  return loadConfiguredStdioEntries().length > 0;
}

function getRequestId(): number {
  const id = nextRequestId;
  nextRequestId += 1;
  return id;
}

function buildInitializeRequest(): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: getRequestId(),
    method: "initialize",
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: ACP_CLIENT_INFO,
    },
  };
}

function buildSessionRequest(cwd: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: getRequestId(),
    method: "session/new",
    params: {
      cwd,
      mcpServers: [],
    },
  };
}

function buildPromptRequest(sessionId: string, prompt: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: getRequestId(),
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [
        {
          type: "text",
          text: prompt,
        },
      ],
    },
  };
}

export function parseJsonRpcMessages(payload: string): JsonRpcResponse[] {
  const trimmed = payload.trim();
  if (!trimmed) {
    return [];
  }

  const messages: JsonRpcResponse[] = [];
  if (trimmed.includes("data:")) {
    let eventLines: string[] = [];

    const flushEvent = () => {
      if (eventLines.length === 0) {
        return;
      }

      const data = eventLines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();

      eventLines = [];
      if (!data || data === "[DONE]") {
        return;
      }

      try {
        messages.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        // ignore malformed frames
      }
    };

    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) {
        flushEvent();
        continue;
      }

      eventLines.push(line);
    }

    flushEvent();
    return messages;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as JsonRpcResponse[];
    }

    return [parsed as JsonRpcResponse];
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      const value = line.trim();
      if (!value) {
        continue;
      }

      try {
        messages.push(JSON.parse(value) as JsonRpcResponse);
      } catch {
        // ignore malformed lines
      }
    }
  }

  return messages;
}

async function postJsonRpc(
  endpoint: string,
  body: JsonRpcRequest,
  timeoutMs: number,
): Promise<JsonRpcResponse[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream, text/plain",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    const text = await response.text();
    return parseJsonRpcMessages(text);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function createStdioTransport(
  entry: StdioRegistryEntry,
  sessionCwd: string,
): Promise<StdioTransportHandle> {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    return await createBunStdioTransport(entry, sessionCwd);
  }

  return createNodeStdioTransport(entry, sessionCwd);
}

function attachStdoutMessageHandler(
  chunk: string,
  state: { stdoutBuffer: string; pending: StdioPendingRequest | null },
): void {
  state.stdoutBuffer += chunk;

  while (state.stdoutBuffer.includes("\n")) {
    const newlineIndex = state.stdoutBuffer.indexOf("\n");
    const line = state.stdoutBuffer.slice(0, newlineIndex).trim();
    state.stdoutBuffer = state.stdoutBuffer.slice(newlineIndex + 1);

    if (!line) {
      continue;
    }

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      continue;
    }

    if (!state.pending) {
      continue;
    }

    state.pending.messages.push(message);
    if (message.id === state.pending.id) {
      const completed = state.pending;
      state.pending = null;
      clearTimeout(completed.timer);
      completed.resolve(completed.messages);
    }
  }
}

function createNodeStdioTransport(
  entry: StdioRegistryEntry,
  sessionCwd: string,
): StdioTransportHandle {
  const child = spawn(entry.command, entry.args, {
    cwd: entry.cwd || sessionCwd,
    env: {
      ...process.env,
      ...entry.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = {
    pending: null as StdioPendingRequest | null,
    stdoutBuffer: "",
  };
  let stderrBuffer = "";

  const rejectPending = (error: Error) => {
    if (!state.pending) {
      return;
    }

    clearTimeout(state.pending.timer);
    state.pending.reject(error);
    state.pending = null;
  };

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  child.stdout.on("data", (chunk) => {
    attachStdoutMessageHandler(chunk.toString(), state);
  });

  child.on("error", (error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  });

  child.on("exit", (code, signal) => {
    if (!state.pending) {
      return;
    }

    const stderr = stderrBuffer.trim();
    rejectPending(
      new Error(
        `ACP stdio process exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"})${stderr ? `: ${stderr}` : ""}`,
      ),
    );
  });

  return {
    sendRequest: async (
      request: JsonRpcRequest,
      timeoutMs: number,
    ): Promise<JsonRpcResponse[]> => {
      if (state.pending) {
        throw new Error(
          "ACP stdio transport does not support concurrent requests",
        );
      }

      return await new Promise<JsonRpcResponse[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          rejectPending(
            new Error(
              `ACP stdio request timed out for ${entry.name}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ""}`,
            ),
          );
        }, timeoutMs);

        state.pending = {
          id: request.id,
          resolve,
          reject,
          messages: [],
          timer,
        };

        child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (!error) {
            return;
          }

          rejectPending(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      });
    },
    close: async () => {
      if (!child.killed) {
        child.stdin.end();
        child.kill();
      }
    },
  };
}

async function readBunStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const trailing = decoder.decode();
        if (trailing) {
          onChunk(trailing);
        }
        return;
      }

      if (value) {
        onChunk(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function createBunStdioTransport(
  entry: StdioRegistryEntry,
  sessionCwd: string,
): Promise<StdioTransportHandle> {
  const useNodeProxy = getBunStdioProxyEnabled();
  const nodePath = process.env.ACP_STDIO_NODE_PATH || "node";
  const command = useNodeProxy
    ? [nodePath, "-e", ACP_BUN_STDIO_NODE_WRAPPER, entry.command, ...entry.args]
    : [entry.command, ...entry.args];

  debug(
    `[acp] starting Bun stdio transport for ${entry.name} with ${useNodeProxy ? "node-proxy" : "direct"} mode`,
  );

  const child = Bun.spawn(command, {
    cwd: entry.cwd || sessionCwd,
    env: {
      ...process.env,
      ...entry.env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as BunStdioProcess;

  const state = {
    pending: null as StdioPendingRequest | null,
    stdoutBuffer: "",
  };
  let stderrBuffer = "";
  let closed = false;

  const rejectPending = (error: Error) => {
    if (!state.pending) {
      return;
    }

    clearTimeout(state.pending.timer);
    state.pending.reject(error);
    state.pending = null;
  };

  void readBunStream(child.stdout, (chunk) => {
    attachStdoutMessageHandler(chunk, state);
  }).catch((error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  });

  void readBunStream(child.stderr, (chunk) => {
    stderrBuffer += chunk;
  }).catch(() => {
    // ignore stderr reader failures here and rely on process exit handling
  });

  void child.exited.then((code) => {
    if (closed || !state.pending) {
      return;
    }

    const stderr = stderrBuffer.trim();
    rejectPending(
      new Error(
        `ACP stdio process exited before responding (code=${code})${stderr ? `: ${stderr}` : ""}`,
      ),
    );
  });

  return {
    sendRequest: async (
      request: JsonRpcRequest,
      timeoutMs: number,
    ): Promise<JsonRpcResponse[]> => {
      if (state.pending) {
        throw new Error(
          "ACP stdio transport does not support concurrent requests",
        );
      }

      return await new Promise<JsonRpcResponse[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          rejectPending(
            new Error(
              `ACP stdio request timed out for ${entry.name}${stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ""}`,
            ),
          );
        }, timeoutMs);

        state.pending = {
          id: request.id,
          resolve,
          reject,
          messages: [],
          timer,
        };

        Promise.resolve(child.stdin.write(`${JSON.stringify(request)}\n`))
          .then(() => Promise.resolve(child.stdin.flush()))
          .catch((error) => {
            rejectPending(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      });
    },
    close: async () => {
      closed = true;

      try {
        await Promise.resolve(child.stdin.end());
      } catch {
        // ignore close errors during shutdown
      }

      child.kill();
      await child.exited.catch(() => undefined);
    },
  };
}

function findResponseForId(
  messages: JsonRpcResponse[],
  id: number,
): JsonRpcResponse | null {
  for (const message of messages) {
    if (message.id === id) {
      return message;
    }
  }

  return null;
}

function extractTextFromContent(content: unknown): string[] {
  if (!content) {
    return [];
  }

  if (Array.isArray(content)) {
    return content.flatMap((entry) => extractTextFromContent(entry));
  }

  if (typeof content !== "object") {
    return [];
  }

  const record = content as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return [record.text];
  }

  if (record.type === "content" && record.content) {
    return extractTextFromContent(record.content);
  }

  return [];
}

function collectPromptText(messages: JsonRpcResponse[]): string {
  const chunks: string[] = [];

  for (const message of messages) {
    if (message.method !== "session/update" || !message.params) {
      continue;
    }

    const update = message.params.update as Record<string, unknown> | undefined;
    if (!update) {
      continue;
    }

    if (update.sessionUpdate === "agent_message_chunk") {
      chunks.push(...extractTextFromContent(update.content));
      continue;
    }

    if (update.sessionUpdate === "tool_call_update") {
      chunks.push(...extractTextFromContent(update.content));
    }
  }

  return chunks.join("\n").trim();
}

async function createHttpSession(
  endpoint: string,
  cwd: string,
): Promise<string | null> {
  const request = buildSessionRequest(cwd);
  const messages = await postJsonRpc(
    endpoint,
    request,
    getDiscoveryTimeoutMs(),
  );
  const response = findResponseForId(messages, request.id);
  const result = response?.result as Record<string, unknown> | undefined;
  return typeof result?.sessionId === "string" ? result.sessionId : null;
}

async function getOrCreateHttpSession(
  endpoint: string,
  cwd: string,
  newSession?: boolean,
): Promise<string | null> {
  const cacheKey = `${endpoint}::${cwd}`;
  if (!newSession) {
    const existing = sessionCache.get(cacheKey);
    if (existing) {
      return existing.sessionId;
    }
  }

  const sessionId = await createHttpSession(endpoint, cwd);
  if (!sessionId) {
    return null;
  }

  sessionCache.set(cacheKey, {
    sessionId,
    endpoint,
    cwd,
  });

  return sessionId;
}

export async function runInitializeOverStdio(
  entry: StdioRegistryEntry,
): Promise<AcpInitializeResult | null> {
  const transport = await createStdioTransport(entry, getDefaultWorkspace());

  try {
    const request = buildInitializeRequest();
    const messages = await transport.sendRequest(
      request,
      getDiscoveryTimeoutMs(),
    );
    const response = findResponseForId(messages, request.id);
    return (response?.result as AcpInitializeResult | undefined) || null;
  } catch {
    return null;
  } finally {
    await transport.close();
  }
}

function normalizeLauncherEnv(
  launcherEnv: unknown,
): Record<string, string> | undefined {
  if (!launcherEnv || typeof launcherEnv !== "object") {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    launcherEnv as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function sendPromptToAcpServer(
  record: AcpServerRecord,
  prompt: string,
  cwd: string,
  newSession?: boolean,
): Promise<string> {
  if (record.transport === "stdio") {
    const metadata = safeJsonParse<Record<string, unknown>>(
      record.metadataJson,
      {},
    );
    const launcher = metadata.launcher as Record<string, unknown> | undefined;
    if (!launcher || typeof launcher.command !== "string") {
      throw new Error(
        `missing ACP stdio launcher config for ${record.toolName}`,
      );
    }

    const entry: StdioRegistryEntry = {
      name:
        typeof launcher.name === "string"
          ? launcher.name
          : record.agentTitle || record.agentName,
      command: launcher.command,
      args: Array.isArray(launcher.args)
        ? launcher.args.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      env: normalizeLauncherEnv(launcher.env),
      cwd: typeof launcher.cwd === "string" ? launcher.cwd : undefined,
      toolName:
        typeof launcher.toolName === "string" ? launcher.toolName : undefined,
    };

    const transport = await createStdioTransport(entry, cwd);
    try {
      const initRequest = buildInitializeRequest();
      await transport.sendRequest(initRequest, getDiscoveryTimeoutMs());

      const sessionRequest = buildSessionRequest(cwd);
      const sessionMessages = await transport.sendRequest(
        sessionRequest,
        getDiscoveryTimeoutMs(),
      );
      const sessionResponse = findResponseForId(
        sessionMessages,
        sessionRequest.id,
      );
      const sessionResult = sessionResponse?.result as
        | Record<string, unknown>
        | undefined;
      const sessionId =
        typeof sessionResult?.sessionId === "string"
          ? sessionResult.sessionId
          : null;
      if (!sessionId) {
        throw new Error(
          `failed to create ACP stdio session for ${record.toolName}`,
        );
      }

      const promptRequest = buildPromptRequest(sessionId, prompt);
      const promptMessages = await transport.sendRequest(
        promptRequest,
        getPromptTimeoutMs(),
      );
      const promptResponse = findResponseForId(
        promptMessages,
        promptRequest.id,
      );
      if (promptResponse?.error?.message) {
        throw new Error(promptResponse.error.message);
      }

      const text = collectPromptText(promptMessages);
      if (text) {
        return text;
      }

      const stopReason = (
        promptResponse?.result as Record<string, unknown> | undefined
      )?.stopReason;
      if (typeof stopReason === "string") {
        return `ACP agent completed with stop reason: ${stopReason}`;
      }

      return `ACP agent ${record.agentTitle || record.agentName} completed without returning text.`;
    } finally {
      await transport.close();
    }
  }

  const attempt = async (forceFreshSession: boolean): Promise<string> => {
    const sessionId = await getOrCreateHttpSession(
      record.endpoint,
      cwd,
      forceFreshSession || newSession,
    );
    if (!sessionId) {
      throw new Error(`failed to create ACP session for ${record.endpoint}`);
    }

    const request = buildPromptRequest(sessionId, prompt);
    const messages = await postJsonRpc(
      record.endpoint,
      request,
      getPromptTimeoutMs(),
    );
    const response = findResponseForId(messages, request.id);
    if (response?.error?.message) {
      throw new Error(response.error.message);
    }

    const text = collectPromptText(messages);
    if (text) {
      return text;
    }

    const stopReason = (response?.result as Record<string, unknown> | undefined)
      ?.stopReason;
    if (typeof stopReason === "string") {
      return `ACP agent completed with stop reason: ${stopReason}`;
    }

    throw new Error("ACP agent completed without returning text");
  };

  try {
    return await attempt(false);
  } catch (error) {
    const cacheKey = `${record.endpoint}::${cwd}`;
    sessionCache.delete(cacheKey);
    debug(`[acp] retrying ${record.endpoint} with a fresh session`);

    try {
      return await attempt(true);
    } catch {
      throw error;
    }
  }
}

function makeDynamicTool(record: AcpServerRecord): ToolDefinition {
  const label = record.agentTitle || record.agentName;
  const schema = z.object({
    prompt: z
      .string()
      .describe("task or instruction to send to this ACP agent"),
    cwd: z
      .string()
      .optional()
      .describe(
        "absolute working directory for the ACP session. defaults to crusty's workspace",
      ),
    newSession: z
      .boolean()
      .optional()
      .describe(
        "start a fresh ACP session instead of reusing the existing one",
      ),
  });

  return {
    description: `delegate work to discovered ACP agent ${label} via ${record.transport} transport at ${record.endpoint}. use this when that agent is better suited to handle the task or to orchestrate its attached tools and services.`,
    schema,
    handler: async (args: z.infer<typeof schema>) => {
      const toolCwd = args.cwd || getDefaultWorkspace();
      return await sendPromptToAcpServer(
        record,
        args.prompt,
        toolCwd,
        args.newSession,
      );
    },
  };
}

function hydrateDynamicTools(records: AcpServerRecord[]): void {
  clearDynamicTools(ACP_DYNAMIC_TOOL_PREFIX);

  if (records.length === 0) {
    return;
  }

  const tools: Record<string, ToolDefinition> = {};
  for (const record of records) {
    tools[record.toolName] = makeDynamicTool(record);
  }

  registerDynamicTools(tools);
}

async function readDiscoveryState(): Promise<DiscoveryStateRow | null> {
  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    return await asyncDb.get<DiscoveryStateRow>(
      `SELECT bootstrapped, last_scan_at, last_scan_mode FROM acp_discovery_state WHERE id = 1`,
    );
  }

  return (
    getDatabase()
      .query<DiscoveryStateRow>(
        `SELECT bootstrapped, last_scan_at, last_scan_mode FROM acp_discovery_state WHERE id = 1`,
      )
      .get() || null
  );
}

async function writeDiscoveryState(
  bootstrapped: boolean,
  scanMode: string,
): Promise<void> {
  const now = Date.now();
  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    await asyncDb.run(
      `INSERT INTO acp_discovery_state (id, bootstrapped, last_scan_at, last_scan_mode)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         bootstrapped = EXCLUDED.bootstrapped,
         last_scan_at = EXCLUDED.last_scan_at,
         last_scan_mode = EXCLUDED.last_scan_mode`,
      [bootstrapped ? 1 : 0, now, scanMode],
    );
    return;
  }

  getDatabase().run(
    `INSERT INTO acp_discovery_state (id, bootstrapped, last_scan_at, last_scan_mode)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       bootstrapped = excluded.bootstrapped,
       last_scan_at = excluded.last_scan_at,
       last_scan_mode = excluded.last_scan_mode`,
    [1, bootstrapped ? 1 : 0, now, scanMode],
  );
}

async function loadPersistedServers(): Promise<AcpServerRecord[]> {
  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    const rows = await asyncDb.all<{
      transport: AcpTransport;
      endpoint: string;
      tool_name: string;
      host: string;
      port: number;
      path: string;
      protocol_version: number | null;
      agent_name: string;
      agent_title: string | null;
      agent_version: string | null;
      capabilities_json: string;
      auth_methods_json: string;
      metadata_json: string;
      first_seen_at: number;
      last_seen_at: number;
      active: number;
    }>(
      `SELECT transport, endpoint, tool_name, host, port, path, protocol_version, agent_name, agent_title, agent_version,
              capabilities_json, auth_methods_json, metadata_json, first_seen_at, last_seen_at, active
       FROM acp_servers
       WHERE active = 1
       ORDER BY last_seen_at DESC, tool_name ASC`,
    );

    return rows.map((row) => ({
      transport: row.transport,
      endpoint: row.endpoint,
      toolName: row.tool_name,
      host: row.host,
      port: row.port,
      path: row.path,
      protocolVersion: row.protocol_version ?? ACP_PROTOCOL_VERSION,
      agentName: row.agent_name,
      agentTitle: row.agent_title,
      agentVersion: row.agent_version,
      capabilitiesJson: row.capabilities_json,
      authMethodsJson: row.auth_methods_json,
      metadataJson: row.metadata_json,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      active: row.active,
    }));
  }

  const rows = getDatabase()
    .query<{
      transport: AcpTransport;
      endpoint: string;
      tool_name: string;
      host: string;
      port: number;
      path: string;
      protocol_version: number | null;
      agent_name: string;
      agent_title: string | null;
      agent_version: string | null;
      capabilities_json: string;
      auth_methods_json: string;
      metadata_json: string;
      first_seen_at: number;
      last_seen_at: number;
      active: number;
    }>(
      `SELECT transport, endpoint, tool_name, host, port, path, protocol_version, agent_name, agent_title, agent_version,
              capabilities_json, auth_methods_json, metadata_json, first_seen_at, last_seen_at, active
       FROM acp_servers
       WHERE active = 1
       ORDER BY last_seen_at DESC, tool_name ASC`,
    )
    .all();

  return rows.map((row) => ({
    transport: row.transport,
    endpoint: row.endpoint,
    toolName: row.tool_name,
    host: row.host,
    port: row.port,
    path: row.path,
    protocolVersion: row.protocol_version ?? ACP_PROTOCOL_VERSION,
    agentName: row.agent_name,
    agentTitle: row.agent_title,
    agentVersion: row.agent_version,
    capabilitiesJson: row.capabilities_json,
    authMethodsJson: row.auth_methods_json,
    metadataJson: row.metadata_json,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    active: row.active,
  }));
}

async function upsertDiscoveredServers(
  records: AcpServerRecord[],
): Promise<void> {
  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    for (const record of records) {
      await asyncDb.run(
        `INSERT INTO acp_servers (
          transport, endpoint, tool_name, host, port, path, protocol_version,
          agent_name, agent_title, agent_version, capabilities_json,
          auth_methods_json, metadata_json, first_seen_at, last_seen_at, active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (endpoint) DO UPDATE SET
          transport = EXCLUDED.transport,
          tool_name = EXCLUDED.tool_name,
          host = EXCLUDED.host,
          port = EXCLUDED.port,
          path = EXCLUDED.path,
          protocol_version = EXCLUDED.protocol_version,
          agent_name = EXCLUDED.agent_name,
          agent_title = EXCLUDED.agent_title,
          agent_version = EXCLUDED.agent_version,
          capabilities_json = EXCLUDED.capabilities_json,
          auth_methods_json = EXCLUDED.auth_methods_json,
          metadata_json = EXCLUDED.metadata_json,
          last_seen_at = EXCLUDED.last_seen_at,
          active = EXCLUDED.active`,
        [
          record.transport,
          record.endpoint,
          record.toolName,
          record.host,
          record.port,
          record.path,
          record.protocolVersion,
          record.agentName,
          record.agentTitle,
          record.agentVersion,
          record.capabilitiesJson,
          record.authMethodsJson,
          record.metadataJson,
          record.firstSeenAt,
          record.lastSeenAt,
          record.active,
        ],
      );
    }

    return;
  }

  const db = getDatabase();
  for (const record of records) {
    db.run(
      `INSERT INTO acp_servers (
        transport, endpoint, tool_name, host, port, path, protocol_version,
        agent_name, agent_title, agent_version, capabilities_json,
        auth_methods_json, metadata_json, first_seen_at, last_seen_at, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        transport = excluded.transport,
        tool_name = excluded.tool_name,
        host = excluded.host,
        port = excluded.port,
        path = excluded.path,
        protocol_version = excluded.protocol_version,
        agent_name = excluded.agent_name,
        agent_title = excluded.agent_title,
        agent_version = excluded.agent_version,
        capabilities_json = excluded.capabilities_json,
        auth_methods_json = excluded.auth_methods_json,
        metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at,
        active = excluded.active`,
      [
        record.transport,
        record.endpoint,
        record.toolName,
        record.host,
        record.port,
        record.path,
        record.protocolVersion,
        record.agentName,
        record.agentTitle,
        record.agentVersion,
        record.capabilitiesJson,
        record.authMethodsJson,
        record.metadataJson,
        record.firstSeenAt,
        record.lastSeenAt,
        record.active,
      ],
    );
  }
}

async function markServersInactive(transport?: AcpTransport): Promise<void> {
  const clause = transport ? ` WHERE transport = '${transport}'` : "";
  const asyncDb = getAsyncDatabase();
  if (asyncDb) {
    await asyncDb.run(`UPDATE acp_servers SET active = 0${clause}`);
    return;
  }

  getDatabase().run(`UPDATE acp_servers SET active = 0${clause}`);
}

async function probeHttpCandidate(
  candidate: PortHint,
): Promise<AcpServerRecord | null> {
  const endpoint = `http://${candidate.host}:${candidate.port}${candidate.path}`;
  const initializeRequest = buildInitializeRequest();
  const messages = await postJsonRpc(
    endpoint,
    initializeRequest,
    getDiscoveryTimeoutMs(),
  );
  const response = findResponseForId(messages, initializeRequest.id);
  const result = response?.result as AcpInitializeResult | null | undefined;

  if (!result || !result.agentInfo?.name) {
    return null;
  }

  const now = Date.now();
  return {
    transport: "http",
    endpoint,
    toolName: "",
    host: candidate.host,
    port: candidate.port,
    path: candidate.path,
    protocolVersion: result.protocolVersion || ACP_PROTOCOL_VERSION,
    agentName: result.agentInfo.name,
    agentTitle: result.agentInfo.title || null,
    agentVersion: result.agentInfo.version || null,
    capabilitiesJson: JSON.stringify(result.agentCapabilities || {}),
    authMethodsJson: JSON.stringify(result.authMethods || []),
    metadataJson: JSON.stringify({ transport: "http", discoveredBy: "scan" }),
    firstSeenAt: now,
    lastSeenAt: now,
    active: 1,
  };
}

async function probeConfiguredStdioEntry(
  entry: StdioRegistryEntry,
): Promise<AcpServerRecord | null> {
  const result = await runInitializeOverStdio(entry);
  if (!result?.agentInfo?.name) {
    return null;
  }

  const now = Date.now();
  return {
    transport: "stdio",
    endpoint: `stdio://${sanitizeToolSlug(entry.name) || sanitizeToolSlug(entry.command) || "agent"}`,
    toolName: entry.toolName || "",
    host: "stdio",
    port: 0,
    path: entry.name,
    protocolVersion: result.protocolVersion || ACP_PROTOCOL_VERSION,
    agentName: result.agentInfo.name,
    agentTitle: result.agentInfo.title || null,
    agentVersion: result.agentInfo.version || null,
    capabilitiesJson: JSON.stringify(result.agentCapabilities || {}),
    authMethodsJson: JSON.stringify(result.authMethods || []),
    metadataJson: JSON.stringify({ transport: "stdio", launcher: entry }),
    firstSeenAt: now,
    lastSeenAt: now,
    active: 1,
  };
}

async function runWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  let index = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await worker(items[currentIndex]!);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

async function discoverHttpAcpServers(): Promise<AcpServerRecord[]> {
  const listeningPorts = getDiscoveryPorts();
  if (listeningPorts.length === 0) {
    return [];
  }

  const candidates: PortHint[] = [];
  const seenCandidates = new Set<string>();

  for (const port of listeningPorts) {
    for (const host of getDiscoveryHosts()) {
      for (const path of getDiscoveryPaths()) {
        const key = `${host}:${port}${path}`;
        if (seenCandidates.has(key)) {
          continue;
        }

        seenCandidates.add(key);
        candidates.push({ host, port, path });
      }
    }
  }

  const probed = await runWithConcurrency(candidates, 24, async (candidate) => {
    return await probeHttpCandidate(candidate);
  });

  const discovered = probed.filter(
    (record): record is AcpServerRecord => !!record,
  );
  const uniqueByEndpoint = new Map<string, AcpServerRecord>();
  for (const record of discovered) {
    if (!uniqueByEndpoint.has(record.endpoint)) {
      uniqueByEndpoint.set(record.endpoint, record);
    }
  }

  return [...uniqueByEndpoint.values()];
}

async function discoverConfiguredStdioServers(): Promise<AcpServerRecord[]> {
  const entries = loadConfiguredStdioEntries();
  if (entries.length === 0) {
    return [];
  }

  const probed = await runWithConcurrency(entries, 8, async (entry) => {
    return await probeConfiguredStdioEntry(entry);
  });

  return probed.filter((record): record is AcpServerRecord => !!record);
}

function assignDiscoveredToolNames(
  records: AcpServerRecord[],
  previousRecords: AcpServerRecord[],
  refreshedTransports: Set<AcpTransport>,
): void {
  const previousByEndpoint = new Map(
    previousRecords.map((record) => [record.endpoint, record] as const),
  );
  const reservedNames = new Set(
    previousRecords
      .filter((record) => !refreshedTransports.has(record.transport))
      .map((record) => record.toolName),
  );

  for (const record of records) {
    const previous = previousByEndpoint.get(record.endpoint);
    if (previous?.toolName) {
      record.toolName = previous.toolName;
      reservedNames.add(previous.toolName);
      continue;
    }

    const preferredName =
      record.toolName ||
      record.agentTitle ||
      record.agentName ||
      `${record.host}_${record.port}`;
    record.toolName = buildAcpToolName(preferredName, reservedNames);
  }
}

export async function rediscoverAcpAgents(options?: {
  http?: boolean;
  stdio?: boolean;
  reason?: string;
}): Promise<AcpServerRecord[]> {
  const refreshHttp = options?.http ?? true;
  const refreshStdio = options?.stdio ?? true;
  const refreshedTransports = new Set<AcpTransport>();
  const previousRecords = await loadPersistedServers();
  const discovered: AcpServerRecord[] = [];

  if (refreshHttp) {
    refreshedTransports.add("http");
    await markServersInactive("http");
    discovered.push(...(await discoverHttpAcpServers()));
  }

  if (refreshStdio) {
    refreshedTransports.add("stdio");
    await markServersInactive("stdio");
    discovered.push(...(await discoverConfiguredStdioServers()));
  }

  assignDiscoveredToolNames(discovered, previousRecords, refreshedTransports);

  if (discovered.length > 0) {
    await upsertDiscoveredServers(discovered);
  }

  if (refreshHttp || refreshStdio) {
    const mode =
      options?.reason ||
      `${refreshHttp ? "http" : ""}${refreshHttp && refreshStdio ? "+" : ""}${refreshStdio ? "stdio" : ""}`;
    await writeDiscoveryState(true, mode);
  }

  const activeRecords = await loadPersistedServers();
  hydrateDynamicTools(activeRecords);
  return activeRecords;
}

async function performAggressiveDiscovery(): Promise<AcpServerRecord[]> {
  debug("[acp] starting aggressive ACP discovery");
  const discovered = await rediscoverAcpAgents({
    http: true,
    stdio: true,
    reason: "aggressive",
  });
  debug(`[acp] discovered ${discovered.length} ACP server(s)`);
  return discovered;
}

export async function initializeAcpDiscovery(): Promise<void> {
  if (process.env.ACP_DISCOVERY_ENABLED === "false") {
    debug("[acp] discovery disabled by environment");
    clearDynamicTools(ACP_DYNAMIC_TOOL_PREFIX);
    return;
  }

  const state = await readDiscoveryState();
  const persisted = await loadPersistedServers();

  if (persisted.length > 0) {
    hydrateDynamicTools(persisted);
  }

  const shouldRunHttpDiscovery = !state?.bootstrapped || persisted.length === 0;
  const shouldRunStdioDiscovery = hasConfiguredStdioRegistry();

  if (!shouldRunHttpDiscovery && !shouldRunStdioDiscovery) {
    debug(`[acp] restored ${persisted.length} ACP tool(s) from cache`);
    return;
  }

  const discovered = shouldRunHttpDiscovery
    ? await performAggressiveDiscovery()
    : await rediscoverAcpAgents({
        http: false,
        stdio: true,
        reason: "stdio_boot",
      });

  hydrateDynamicTools(discovered);
}

export function getAcpServerSummary(record: AcpServerRecord): string {
  const capabilities = safeJsonParse<Record<string, unknown>>(
    record.capabilitiesJson,
    {},
  );
  return `${record.toolName}: ${record.agentTitle || record.agentName} [${record.transport}] (${record.endpoint}) capabilities=${JSON.stringify(capabilities)}`;
}
