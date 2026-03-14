import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { executeTool, ensureNonEmptyToolResult } from "./registry.ts";
import { getAsyncDatabase, getDatabase } from "../data/db.ts";

describe("executeTool - malformed args recovery", () => {
  it("recovers web_search from quoted key-value string", async () => {
    const result = await executeTool(
      "web_search",
      '"query: bun typescript"',
      0,
    );

    expect(result).not.toContain("error: invalid arguments for web_search");
  });

  it("recovers search_sessions from key-value string", async () => {
    const result = await executeTool("search_sessions", '"query: 4claw"', 0);

    expect(result).not.toContain(
      "error: invalid arguments for search_sessions",
    );
    expect(result).toContain("[Session Search]");
  });

  it("recovers web_fetch from wrapped xml-ish arg string", async () => {
    const result = await executeTool(
      "web_fetch",
      '"url\\\": \\\"https://www.4claw.org/skill.md</parameter>\\n</invoke>"',
      0,
    );

    expect(result).not.toContain("expected object, received string");
  });

  it("recovers recall_memory from string-style query args", async () => {
    const result = await executeTool(
      "recall_memory",
      '"query: 4claw tripcode rsa key"',
      0,
    );

    expect(result).not.toContain("error: invalid arguments for recall_memory");
    expect(result).toContain("[Memory]");
  });

  it("recovers search_memory from string-style query args", async () => {
    const result = await executeTool("search_memory", '"query: 4claw"', 0);

    expect(result).not.toContain("error: invalid arguments for search_memory");
    expect(result).toContain("[Memory Search]");
  });

  it('normalizes web_fetch string args like "url" into object-shaped args', async () => {
    const result = await executeTool("web_fetch", '"url"', 0);

    expect(result).toContain("error: invalid arguments for web_fetch");
    expect(result).toContain("url");
    expect(result).not.toContain("expected object, received string");
  });

  it("coerces browser_scroll bare string args into direction object", async () => {
    const result = await executeTool("browser_scroll", '"down"', 0);

    expect(result).not.toContain("error: invalid arguments for browser_scroll");
    expect(result).toContain("Scrolled down");
  });

  it("coerces browser_scroll quoted direction field for enum validation", async () => {
    const result = await executeTool(
      "browser_scroll",
      '{"direction":"\\"down\\""}',
      0,
    );

    expect(result).not.toContain("error: invalid arguments for browser_scroll");
    expect(result).toContain("Scrolled down");
  });

  it("coerces browser_snapshot bare mode string into object args", async () => {
    const result = await executeTool("browser_snapshot", '"interactive"', 0);

    expect(result).not.toContain(
      "error: invalid arguments for browser_snapshot",
    );
    expect(result).not.toContain("expected object, received string");
  });

  it("recovers command from assistant text when args have garbage command", async () => {
    // garbage command with valid timeout/workdir
    const args = JSON.stringify({
      command: ",",
      timeout: "15000",
      workdir: "/app",
    });

    const result = await executeTool(
      "bash_execute",
      args,
      0,
      "let me run: echo test123",
    );

    // should execute the recovered command successfully
    expect(result).toContain("test123");
    expect(result).toContain("exit code: 0");
    expect(result).not.toContain("error:");
  });

  it("handles comma-only command with assistant text recovery", async () => {
    const args = JSON.stringify({ command: "," });

    const result = await executeTool("bash_execute", args, 0, "run this: pwd");

    // should execute pwd successfully (returns a path)
    expect(result).toContain("/");
    expect(result).toContain("exit code: 0");
    expect(result).not.toContain("error:");
  });

  it("returns clear error when no valid command can be recovered", async () => {
    const args = JSON.stringify({ command: ",", timeout: "15000" });

    const result = await executeTool("bash_execute", args, 0);

    // should give a helpful error message
    expect(result).toContain("error:");
    expect(result).toContain("command");
    expect(result).toContain("format:");
    expect(result).not.toContain("received undefined");
  });

  it("preserves original valid args when recovery finds command in assistant text", async () => {
    const args = `{"command":",", "timeout": "15000", "workdir": "/tmp"}`;

    const result = await executeTool("bash_execute", args, 0, "run: ls -la");

    // should execute ls and show directory listing
    expect(result).toContain("exit code:");
    expect(result).not.toContain("error:");
  });

  it("handles command with only punctuation", async () => {
    const args = JSON.stringify({ command: ":", timeout: "15000" });

    const result = await executeTool(
      "bash_execute",
      args,
      0,
      "execute: echo hello",
    );

    expect(result).toContain("hello");
    expect(result).toContain("exit code: 0");
    expect(result).not.toContain("error:");
  });

  it("handles malformed JSON that can be partially parsed", async () => {
    // this JSON has escaped quotes which makes it malformed
    const args = `{"command":"whoami"}`;

    const result = await executeTool("bash_execute", args, 0);

    // whoami should execute and return a username
    expect(result).toContain("exit code: 0");
    expect(result).not.toContain("error:");
  });

  it("handles empty command string with assistant recovery", async () => {
    const args = JSON.stringify({ command: "" });

    const result = await executeTool(
      "bash_execute",
      args,
      0,
      "let's see: whoami",
    );

    // should execute whoami successfully
    expect(result).toContain("exit code: 0");
    expect(result).not.toContain("error:");
  });

  it("validates that recovered command is actually valid", async () => {
    const args = JSON.stringify({ command: "!!" });

    const result = await executeTool(
      "bash_execute",
      args,
      0,
      "no command here",
    );

    // should fail gracefully with a clear message
    expect(result).toContain("error:");
    expect(result).toContain("command");
  });

  it("extracts command from broken args even without assistant text", async () => {
    // the command pattern should find 'echo test' in the broken args string
    const args = `garbage stuff echo test more garbage`;

    const result = await executeTool("bash_execute", args, 0);

    // should extract and execute 'echo test'
    expect(result).toContain("test");
    expect(result).toContain("exit code: 0");
  });

  it("handles url-like commands correctly", async () => {
    // model sometimes prepends https: to commands
    const args = JSON.stringify({ command: "https://echo hello" });

    const result = await executeTool("bash_execute", args, 0);

    // sanitization should strip the https:// prefix
    expect(result).toContain("hello");
    expect(result).toContain("exit code: 0");
  });

  it("accepts raw string command payloads for bash_execute", async () => {
    const testKeyPath = `/tmp/registry-test-rsa-${Date.now()}`;
    const malformedKeyPath = `/tmp/registry-test-rsa2-${Date.now()}`;

    const validRaw = JSON.stringify(
      `ssh-keygen -t rsa -b 4096 -f ${testKeyPath} -N ""`,
    );

    const result = await executeTool("bash_execute", validRaw, 0);

    expect(result).toContain("exit code: 0");
    expect(result).not.toContain("could not parse a valid command");

    const malformedRaw = `"ssh-keygen -t rsa -b 4096 -f ${malformedKeyPath} -N """`;

    const malformedResult = await executeTool("bash_execute", malformedRaw, 0);

    expect(malformedResult).not.toContain("could not parse a valid command");

    await executeTool(
      "bash_execute",
      JSON.stringify({
        command: `rm -f ${testKeyPath} ${testKeyPath}.pub ${malformedKeyPath} ${malformedKeyPath}.pub`,
      }),
      0,
    );
  });

  it("forces a non-empty result when a tool handler returns blank content", () => {
    const result = ensureNonEmptyToolResult("heartbeat_read", "   ");

    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toContain("[No output]");
    expect(result).toContain("heartbeat_read");
  });
});

describe("executeTool - credentials store", () => {
  const userId = 998877;
  const originalMasterKey = process.env.CRUSTY_CREDENTIALS_MASTER_KEY;
  beforeEach(() => {
    if (originalMasterKey) {
      process.env.CRUSTY_CREDENTIALS_MASTER_KEY = originalMasterKey;
      return;
    }

    delete process.env.CRUSTY_CREDENTIALS_MASTER_KEY;
  });

  afterAll(() => {
    if (originalMasterKey) {
      process.env.CRUSTY_CREDENTIALS_MASTER_KEY = originalMasterKey;
      return;
    }

    delete process.env.CRUSTY_CREDENTIALS_MASTER_KEY;
  });

  const owner = `test-skill-${Date.now()}`;
  const name = "api_token";
  const secret = "secret-token-value-123";

  it("returns a clear error when credentials store key is not configured", async () => {
    delete process.env.CRUSTY_CREDENTIALS_MASTER_KEY;

    const result = await executeTool(
      "save_credential",
      JSON.stringify({ scope: "skill", owner, name, value: secret }),
      userId,
    );

    expect(result).toContain("Store unavailable");
    expect(result).toContain("CRUSTY_CREDENTIALS_MASTER_KEY");
  });

  it("supports save get list and delete credential flow", async () => {
    process.env.CRUSTY_CREDENTIALS_MASTER_KEY =
      "this-is-a-test-master-key-with-sufficient-length";

    const saveResult = await executeTool(
      "save_credential",
      JSON.stringify({
        scope: "skill",
        owner,
        name,
        value: secret,
        description: "token for integration tests",
      }),
      userId,
    );

    expect(saveResult).toContain("Saved skill/");

    const asyncDb = getAsyncDatabase();
    if (asyncDb) {
      const row = await asyncDb.get<{ encrypted_value: string }>(
        `SELECT encrypted_value FROM credentials WHERE user_id = $1 AND scope = $2 AND owner = $3 AND name = $4`,
        userId,
        "skill",
        owner,
        name,
      );
      expect(row?.encrypted_value).toBeDefined();
      expect(row?.encrypted_value).not.toContain(secret);
    } else {
      const row = getDatabase()
        .query<{
          encrypted_value: string;
        }>(
          `SELECT encrypted_value FROM credentials WHERE user_id = ? AND scope = ? AND owner = ? AND name = ?`,
        )
        .get(userId, "skill", owner, name);
      expect(row?.encrypted_value).toBeDefined();
      expect(row?.encrypted_value).not.toContain(secret);
    }

    const listResult = await executeTool(
      "list_credentials",
      JSON.stringify({ scope: "skill", owner }),
      userId,
    );

    expect(listResult).toContain(`${owner}/${name}`);
    expect(listResult).not.toContain(secret);

    const getResult = await executeTool(
      "get_credential",
      JSON.stringify({ scope: "skill", owner, name }),
      userId,
    );

    expect(getResult).toContain(`skill/${owner}/${name}`);
    expect(getResult).toContain(secret);

    const deleteResult = await executeTool(
      "delete_credential",
      JSON.stringify({ scope: "skill", owner, name }),
      userId,
    );

    expect(deleteResult).toContain("Deleted");

    const afterDelete = await executeTool(
      "get_credential",
      JSON.stringify({ scope: "skill", owner, name }),
      userId,
    );

    expect(afterDelete).toContain("Not found");
  });
});
