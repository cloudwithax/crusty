import { existsSync } from "fs";
import { mkdir, writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";
import { $ } from "bun";
import { spawn } from "child_process";

const SERVICE_NAME = "crusty";

// detect which daemon backend to use
type DaemonBackend = "systemd" | "launchd" | "fork";

async function detectBackend(): Promise<DaemonBackend> {
  if (process.platform === "darwin") {
    return "launchd";
  }

  if (process.platform === "linux") {
    // check for systemd
    const result = await $`pidof systemd`.nothrow().quiet();
    if (result.exitCode === 0) {
      return "systemd";
    }
  }

  // fallback to fork-based daemon for windows or systems without systemd/launchd
  return "fork";
}

// ============ systemd backend ============

const SYSTEMD_DIR = join(process.env.HOME!, ".config", "systemd", "user");
const SYSTEMD_FILE = join(SYSTEMD_DIR, `${SERVICE_NAME}.service`);

function getSystemdContent(): string {
  const crustyPath = process.cwd();
  const bunPath = process.execPath;

  return `[Unit]
Description=Crusty Telegram AI Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${crustyPath}
ExecStart=${bunPath} run start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

async function systemdInstall(): Promise<void> {
  if (!existsSync(SYSTEMD_DIR)) {
    await mkdir(SYSTEMD_DIR, { recursive: true });
  }
  await writeFile(SYSTEMD_FILE, getSystemdContent());
  await $`systemctl --user daemon-reload`.quiet();
}

async function systemdStart(): Promise<void> {
  await systemdInstall();
  await $`systemctl --user enable ${SERVICE_NAME}`.quiet();
  await $`systemctl --user start ${SERVICE_NAME}`.quiet();
  console.log(`[daemon] started ${SERVICE_NAME} via systemd`);
  console.log(`[daemon] logs: journalctl --user -u ${SERVICE_NAME} -f`);
}

async function systemdStop(): Promise<void> {
  await $`systemctl --user stop ${SERVICE_NAME}`.quiet();
  console.log(`[daemon] stopped ${SERVICE_NAME}`);
}

async function systemdDisable(): Promise<void> {
  await $`systemctl --user stop ${SERVICE_NAME}`.nothrow().quiet();
  await $`systemctl --user disable ${SERVICE_NAME}`.nothrow().quiet();
  if (existsSync(SYSTEMD_FILE)) await unlink(SYSTEMD_FILE);
  await $`systemctl --user daemon-reload`.quiet();
  console.log(`[daemon] disabled and removed ${SERVICE_NAME} service`);
}

async function systemdStatus(): Promise<void> {
  const result = await $`systemctl --user status ${SERVICE_NAME}`.nothrow();
  console.log(result.stdout.toString());
}

// ============ launchd backend (macos) ============

const LAUNCHD_DIR = join(process.env.HOME!, "Library", "LaunchAgents");
const LAUNCHD_FILE = join(LAUNCHD_DIR, `com.crusty.agent.plist`);
const LAUNCHD_LABEL = "com.crusty.agent";

function getLaunchdContent(): string {
  const crustyPath = process.cwd();
  const bunPath = process.execPath;
  const logPath = join(crustyPath, "crusty-daemon.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${crustyPath}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;
}

async function launchdStart(): Promise<void> {
  if (!existsSync(LAUNCHD_DIR)) {
    await mkdir(LAUNCHD_DIR, { recursive: true });
  }
  await writeFile(LAUNCHD_FILE, getLaunchdContent());
  await $`launchctl load ${LAUNCHD_FILE}`.quiet();
  console.log(`[daemon] started ${SERVICE_NAME} via launchd`);
  console.log(`[daemon] logs: tail -f ${join(process.cwd(), "crusty-daemon.log")}`);
}

async function launchdStop(): Promise<void> {
  await $`launchctl stop ${LAUNCHD_LABEL}`.nothrow().quiet();
  console.log(`[daemon] stopped ${SERVICE_NAME}`);
}

async function launchdDisable(): Promise<void> {
  await $`launchctl unload ${LAUNCHD_FILE}`.nothrow().quiet();
  if (existsSync(LAUNCHD_FILE)) await unlink(LAUNCHD_FILE);
  console.log(`[daemon] disabled and removed ${SERVICE_NAME} service`);
}

async function launchdStatus(): Promise<void> {
  const result = await $`launchctl list | grep ${LAUNCHD_LABEL}`.nothrow();
  if (result.exitCode === 0) {
    console.log(`[daemon] ${SERVICE_NAME} is running`);
    console.log(result.stdout.toString());
  } else {
    console.log(`[daemon] ${SERVICE_NAME} is not running`);
  }
}

// ============ fork backend (fallback for windows/other) ============

const PID_FILE = join(process.cwd(), ".crusty.pid");
const LOG_FILE = join(process.cwd(), "crusty-daemon.log");

async function forkStart(): Promise<void> {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(await readFile(PID_FILE, "utf-8"));
    try {
      process.kill(pid, 0); // check if process exists
      console.log(`[daemon] ${SERVICE_NAME} already running (pid ${pid})`);
      return;
    } catch {
      // stale pid file, continue
    }
  }

  const bunPath = process.execPath;
  const crustyPath = process.cwd();

  // spawn detached process
  const out = Bun.file(LOG_FILE).writer();
  const child = spawn(bunPath, ["run", "start"], {
    cwd: crustyPath,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });

  // pipe output to log file
  child.stdout?.on("data", (data) => out.write(data));
  child.stderr?.on("data", (data) => out.write(data));

  child.unref();

  if (child.pid) {
    await writeFile(PID_FILE, child.pid.toString());
    console.log(`[daemon] started ${SERVICE_NAME} (pid ${child.pid})`);
    console.log(`[daemon] logs: tail -f ${LOG_FILE}`);
  } else {
    console.error(`[daemon] failed to start ${SERVICE_NAME}`);
  }
}

async function forkStop(): Promise<void> {
  if (!existsSync(PID_FILE)) {
    console.log(`[daemon] ${SERVICE_NAME} is not running`);
    return;
  }

  const pid = parseInt(await readFile(PID_FILE, "utf-8"));
  try {
    process.kill(pid, "SIGTERM");
    await unlink(PID_FILE);
    console.log(`[daemon] stopped ${SERVICE_NAME} (pid ${pid})`);
  } catch (err: any) {
    if (err.code === "ESRCH") {
      await unlink(PID_FILE);
      console.log(`[daemon] ${SERVICE_NAME} was not running (cleaned stale pid)`);
    } else {
      throw err;
    }
  }
}

async function forkDisable(): Promise<void> {
  await forkStop();
  console.log(`[daemon] disabled ${SERVICE_NAME}`);
}

async function forkStatus(): Promise<void> {
  if (!existsSync(PID_FILE)) {
    console.log(`[daemon] ${SERVICE_NAME} is not running`);
    return;
  }

  const pid = parseInt(await readFile(PID_FILE, "utf-8"));
  try {
    process.kill(pid, 0);
    console.log(`[daemon] ${SERVICE_NAME} is running (pid ${pid})`);
  } catch {
    console.log(`[daemon] ${SERVICE_NAME} is not running (stale pid file)`);
  }
}

// ============ public api ============

export async function startDaemon(): Promise<void> {
  const backend = await detectBackend();
  console.log(`[daemon] using ${backend} backend`);

  switch (backend) {
    case "systemd":
      return systemdStart();
    case "launchd":
      return launchdStart();
    case "fork":
      return forkStart();
  }
}

export async function stopDaemon(): Promise<void> {
  const backend = await detectBackend();

  switch (backend) {
    case "systemd":
      return systemdStop();
    case "launchd":
      return launchdStop();
    case "fork":
      return forkStop();
  }
}

export async function disableDaemon(): Promise<void> {
  const backend = await detectBackend();

  switch (backend) {
    case "systemd":
      return systemdDisable();
    case "launchd":
      return launchdDisable();
    case "fork":
      return forkDisable();
  }
}

export async function statusDaemon(): Promise<void> {
  const backend = await detectBackend();

  switch (backend) {
    case "systemd":
      return systemdStatus();
    case "launchd":
      return launchdStatus();
    case "fork":
      return forkStatus();
  }
}
