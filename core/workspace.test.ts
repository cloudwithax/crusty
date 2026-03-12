import { describe, expect, it } from "bun:test";
import { resolveDefaultWorkspace } from "./workspace.ts";

describe("resolveDefaultWorkspace", () => {
  it("uses the current directory locally by default", () => {
    const workspace = resolveDefaultWorkspace({
      cwd: "/tmp/project",
      env: {},
      exists: (path) => path === "/tmp/project",
      isDirectory: (path) => path === "/tmp/project",
      resolvePath: (...paths) => paths[0]!,
    });

    expect(workspace).toBe("/tmp/project");
  });

  it("prefers an explicit workspace override", () => {
    const workspace = resolveDefaultWorkspace({
      cwd: "/tmp/project",
      env: { CRUSTY_WORKSPACE: "/srv/workspace" },
      exists: (path) => path === "/srv/workspace" || path === "/tmp/project",
      isDirectory: (path) =>
        path === "/srv/workspace" || path === "/tmp/project",
      resolvePath: (...paths) => paths[0]!,
    });

    expect(workspace).toBe("/srv/workspace");
  });

  it("prefers a populated docker mount when present", () => {
    const workspace = resolveDefaultWorkspace({
      cwd: "/app",
      env: { CRUSTY_DOCKER: "true" },
      exists: (path) => path === "/workspace" || path === "/app",
      isDirectory: (path) => path === "/workspace" || path === "/app",
      readDir: (path) => (path === "/workspace" ? ["repo"] : ["dist"]),
      resolvePath: (...paths) => paths[0]!,
    });

    expect(workspace).toBe("/workspace");
  });

  it("falls back to the app directory in docker when the mount is empty", () => {
    const workspace = resolveDefaultWorkspace({
      cwd: "/app",
      env: { CRUSTY_DOCKER: "true" },
      exists: (path) => path === "/workspace" || path === "/app",
      isDirectory: (path) => path === "/workspace" || path === "/app",
      readDir: (path) => (path === "/workspace" ? [] : ["dist"]),
      resolvePath: (...paths) => paths[0]!,
    });

    expect(workspace).toBe("/app");
  });

  it("ignores a missing explicit workspace override", () => {
    const workspace = resolveDefaultWorkspace({
      cwd: "/tmp/project",
      env: { CRUSTY_WORKSPACE: "/missing/workspace" },
      exists: (path) => path === "/tmp/project",
      isDirectory: (path) => path === "/tmp/project",
      resolvePath: (...paths) => paths[0]!,
    });

    expect(workspace).toBe("/tmp/project");
  });
});
