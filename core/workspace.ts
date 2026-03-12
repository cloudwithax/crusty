import { existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";

export const WORKSPACE_ENV_VAR = "CRUSTY_WORKSPACE";
const DOCKER_MOUNT_WORKSPACE = "/workspace";
const DOCKER_APP_WORKSPACE = "/app";

interface ResolveWorkspaceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
  readDir?: (path: string) => string[];
  resolvePath?: (...paths: string[]) => string;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeExistingDirectory(
  candidate: string | undefined,
  exists: (path: string) => boolean,
  isDirectory: (path: string) => boolean,
  resolvePath: (...paths: string[]) => string,
): string | null {
  if (!candidate?.trim()) {
    return null;
  }

  const normalized = resolvePath(candidate.trim());
  if (!exists(normalized) || !isDirectory(normalized)) {
    return null;
  }

  return normalized;
}

function hasVisibleEntries(
  directory: string,
  readDir: (path: string) => string[],
): boolean {
  try {
    return readDir(directory).some((entry) => entry !== "." && entry !== "..");
  } catch {
    return false;
  }
}

export function resolveDefaultWorkspace(
  options: ResolveWorkspaceOptions = {},
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const readDir = options.readDir ?? readdirSync;
  const resolvePath = options.resolvePath ?? resolve;
  const isDocker = env.CRUSTY_DOCKER === "true";

  const configuredWorkspace = normalizeExistingDirectory(
    env[WORKSPACE_ENV_VAR],
    exists,
    isDirectory,
    resolvePath,
  );
  if (configuredWorkspace) {
    return configuredWorkspace;
  }

  if (isDocker) {
    const mountedWorkspace = normalizeExistingDirectory(
      DOCKER_MOUNT_WORKSPACE,
      exists,
      isDirectory,
      resolvePath,
    );
    if (mountedWorkspace && hasVisibleEntries(mountedWorkspace, readDir)) {
      return mountedWorkspace;
    }

    const cwdWorkspace = normalizeExistingDirectory(
      cwd,
      exists,
      isDirectory,
      resolvePath,
    );
    if (cwdWorkspace) {
      return cwdWorkspace;
    }

    const appWorkspace = normalizeExistingDirectory(
      DOCKER_APP_WORKSPACE,
      exists,
      isDirectory,
      resolvePath,
    );
    if (appWorkspace) {
      return appWorkspace;
    }
  }

  return (
    normalizeExistingDirectory(cwd, exists, isDirectory, resolvePath) ??
    resolvePath(cwd)
  );
}

export function getDefaultWorkspace(): string {
  return resolveDefaultWorkspace();
}
