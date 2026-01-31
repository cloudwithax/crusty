import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { executeCommand } from "./bash.ts";

describe("executeCommand", () => {
  let originalCrustyShell: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalCrustyShell = process.env.CRUSTY_SHELL;
    tempDir = join(tmpdir(), `crusty-bash-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (originalCrustyShell === undefined) delete process.env.CRUSTY_SHELL;
    else process.env.CRUSTY_SHELL = originalCrustyShell;

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("executes a basic command", async () => {
    const result = await executeCommand("echo ok", 30000, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("falls back when configured shell is missing", async () => {
    process.env.CRUSTY_SHELL = "/this/does/not/exist";
    const result = await executeCommand("echo ok", 30000, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("uses configured shell when present", async () => {
    const customShellPath = join(tempDir, "custom-shell");
    writeFileSync(
      customShellPath,
      `#!/bin/sh
echo crusty-custom-shell >&2
if [ "$1" = "-c" ]; then
  shift
  exec /bin/sh -c "$1"
fi
exec /bin/sh "$@"
`
    );
    chmodSync(customShellPath, 0o755);

    process.env.CRUSTY_SHELL = customShellPath;
    const result = await executeCommand("echo ok", 30000, process.cwd());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toContain("crusty-custom-shell");
  });

  it("times out long-running commands", async () => {
    const result = await executeCommand("sleep 5", 100, process.cwd());
    expect(result.timedOut).toBe(true);
  });
});

