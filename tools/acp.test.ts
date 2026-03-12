import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildAcpToolName,
  getListeningTcpPorts,
  parseAcpStdioRegistry,
  parseJsonRpcMessages,
  runInitializeOverStdio,
} from "./acp.ts";

describe("acp helpers", () => {
  it("creates stable unique ACP tool names", () => {
    const names = new Set<string>();

    expect(buildAcpToolName("Goose Desktop", names)).toBe("acp_goose_desktop");
    expect(buildAcpToolName("Goose Desktop", names)).toBe(
      "acp_goose_desktop_2",
    );
  });

  it("parses SSE JSON-RPC payloads", () => {
    const payload = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
      "",
    ].join("\n");

    const messages = parseJsonRpcMessages(payload);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.method).toBe("session/update");
    expect(messages[1]?.id).toBe(2);
  });

  it("exposes tcp listener scan as a sorted unique list", () => {
    const ports = getListeningTcpPorts();
    expect(Array.isArray(ports)).toBe(true);
    expect([...ports].sort((left, right) => left - right)).toEqual(ports);
  });

  it("parses ACP stdio registry json", () => {
    const entries = parseAcpStdioRegistry(
      JSON.stringify([
        {
          name: "goose",
          command: "goose",
          args: ["acp", "serve"],
          env: { GOOSE_MODE: "acp" },
        },
      ]),
    );

    expect(entries).toEqual([
      {
        name: "goose",
        command: "goose",
        args: ["acp", "serve"],
        env: { GOOSE_MODE: "acp" },
      },
    ]);
  });

  it("initializes a stdio ACP agent under Bun", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "crusty-acp-"));
    const agentPath = join(tempDir, "agent.js");

    writeFileSync(
      agentPath,
      [
        'process.stdin.setEncoding("utf8");',
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  while (buffer.includes('\\n')) {",
        "    const newlineIndex = buffer.indexOf('\\n');",
        "    const line = buffer.slice(0, newlineIndex).trim();",
        "    buffer = buffer.slice(newlineIndex + 1);",
        "    if (!line) continue;",
        "    const message = JSON.parse(line);",
        "    if (message.method !== 'initialize') continue;",
        "    process.stdout.write(JSON.stringify({",
        "      jsonrpc: '2.0',",
        "      id: message.id,",
        "      result: {",
        "        protocolVersion: 1,",
        "        agentInfo: {",
        "          name: 'stdio-test-agent',",
        "          title: 'Stdio Test Agent',",
        "          version: '0.1.0',",
        "        },",
        "      },",
        "    }) + '\\n');",
        "  }",
        "});",
      ].join("\n"),
    );

    try {
      const result = await runInitializeOverStdio({
        name: "stdio-test-agent",
        command: "node",
        args: [agentPath],
      });

      expect(result).toEqual({
        protocolVersion: 1,
        agentInfo: {
          name: "stdio-test-agent",
          title: "Stdio Test Agent",
          version: "0.1.0",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
