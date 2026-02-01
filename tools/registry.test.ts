import { describe, it, expect } from "bun:test";
import { executeTool } from "./registry.ts";

describe("executeTool - malformed args recovery", () => {
  it("recovers command from assistant text when args have garbage command", async () => {
    // garbage command with valid timeout/workdir
    const args = JSON.stringify({ command: ",", timeout: "15000", workdir: "/app" });

    const result = await executeTool("bash_execute", args, 0, "let me run: echo test123");

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

    const result = await executeTool("bash_execute", args, 0, "execute: echo hello");

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

    const result = await executeTool("bash_execute", args, 0, "let's see: whoami");

    // should execute whoami successfully
    expect(result).toContain("exit code: 0");
    expect(result).not.toContain("error:");
  });

  it("validates that recovered command is actually valid", async () => {
    const args = JSON.stringify({ command: "!!" });

    const result = await executeTool("bash_execute", args, 0, "no command here");

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
});
