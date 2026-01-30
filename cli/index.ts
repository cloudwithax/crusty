#!/usr/bin/env bun

const args = process.argv.slice(2);
const command = args[0];
const flags = args.slice(1);

function hasFlag(...names: string[]): boolean {
  return names.some((n) => flags.includes(n));
}

async function showHelp(): Promise<void> {
  console.log(`
crusty - a crab-themed telegram ai agent

usage:
  crusty <command> [options]

commands:
  setup     run the interactive setup wizard
  start     start the telegram bot
  stop      stop the daemon service
  status    show daemon service status

start options:
  --daemon, -d    run as a systemd user service in the background
  --disable       stop and remove the daemon service

general options:
  --help    show this help message
  --version show version number
`);
}

async function showVersion(): Promise<void> {
  const pkg = await import("../package.json");
  console.log(`crusty v${pkg.version}`);
}

async function main(): Promise<void> {
  if (!command || command === "--help" || command === "-h") {
    await showHelp();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    await showVersion();
    process.exit(0);
  }

  switch (command) {
    case "setup":
      // dynamically import to avoid loading everything on --help
      const setup = await import("./setup.ts");
      break;

    case "start":
      if (hasFlag("--daemon", "-d")) {
        const { startDaemon } = await import("./daemon.ts");
        await startDaemon();
      } else if (hasFlag("--disable")) {
        const { disableDaemon } = await import("./daemon.ts");
        await disableDaemon();
      } else {
        // run the main bot in foreground
        await import("../index.ts");
      }
      break;

    case "stop":
      const { stopDaemon } = await import("./daemon.ts");
      await stopDaemon();
      break;

    case "status":
      const { statusDaemon } = await import("./daemon.ts");
      await statusDaemon();
      break;

    default:
      console.error(`unknown command: ${command}`);
      console.error(`run 'crusty --help' for usage`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("fatal error:", error);
  process.exit(1);
});
