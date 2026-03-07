import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { chromium } from "playwright";
import {
  generatePairingCode,
  savePairingCodeAsync,
  loadPairingData,
  clearPairing,
  getPairingCodeRemainingMinutes,
  clearPairingForNewCode,
} from "./pairing.ts";
import {
  generateImessagePairingCode,
  saveImessagePairingCodeAsync,
  loadImessagePairingData,
  clearImessagePairing,
  getImessagePairingCodeRemainingMinutes,
  clearImessagePairingForNewCode,
} from "../imessage/pairing.ts";

const ENV_PATH = join(import.meta.dir, "..", ".env");
const COGS_PATH = join(import.meta.dir, "..", "cogs");

// Simple prompt function for Bun
async function prompt(
  question: string,
  defaultValue?: string,
): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  return new Promise((resolve) => {
    const displayQuestion = defaultValue
      ? `${question} (${defaultValue}): `
      : `${question}: `;
    stdout.write(displayQuestion);

    // ensure stdin is in raw mode for char-by-char reading and is actively reading
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();

    let input = "";

    const onData = (data: Buffer) => {
      const char = data.toString();

      if (char === "\n" || char === "\r") {
        stdout.write("\n");
        stdin.removeListener("data", onData);
        // restore stdin state for next prompt or other uses
        if (typeof stdin.setRawMode === "function") {
          stdin.setRawMode(false);
        }
        const result = input.trim() || defaultValue || "";
        resolve(result);
      } else if (char === "\u0003") {
        process.exit();
      } else if (char === "\u007F") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write("\b \b");
        }
      } else {
        input += char;
        stdout.write(char);
      }
    };

    stdin.on("data", onData);
  });
}

// Checkmark helper
function checkmark(success: boolean): string {
  return success ? "✓" : "✗";
}

// Load current .env file
function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) {
    return {};
  }

  const content = readFileSync(ENV_PATH, "utf-8");
  const env: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key) {
        env[key] = valueParts.join("=").trim();
      }
    }
  }

  return env;
}

// Save .env file
function saveEnv(env: Record<string, string>): void {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
}

// Validate OpenAI API connection
async function validateOpenAIConnection(
  apiKey: string,
  baseUrl?: string,
): Promise<boolean> {
  try {
    const url = baseUrl
      ? `${baseUrl}/models`
      : "https://api.openai.com/v1/models";

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

// Validate browser installation
async function validateBrowser(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

// Configure API settings
async function configureAPI(env: Record<string, string>): Promise<void> {
  console.log("\n=== API Configuration ===\n");

  const currentKey = env.OPENAI_API_KEY || "";
  const maskedKey = currentKey
    ? `${currentKey.slice(0, 8)}...${currentKey.slice(-4)}`
    : "not set";

  console.log(`Current API Key: ${maskedKey}`);
  const newKey = await prompt(
    "Enter OpenAI API Key (or press enter to keep current)",
  );

  if (newKey) {
    env.OPENAI_API_KEY = newKey;
  }

  console.log(
    `\nCurrent Base URL: ${env.OPENAI_BASE_URL || "not set (using OpenAI default)"}`,
  );
  const newBaseUrl = await prompt(
    "Enter Base URL (or press enter to keep current)",
  );

  if (newBaseUrl) {
    env.OPENAI_BASE_URL = newBaseUrl;
  }

  console.log(
    `\nCurrent Model: ${env.OPENAI_MODEL || "not set (using gpt-4o)"}`,
  );
  const newModel = await prompt("Enter Model (or press enter to keep current)");

  if (newModel) {
    env.OPENAI_MODEL = newModel;
  }

  saveEnv(env);
  console.log("\n✓ API configuration saved");
}

// Configure Telegram Bot
async function configureTelegram(env: Record<string, string>): Promise<void> {
  console.log("\n=== Telegram Bot Configuration ===\n");

  const currentToken = env.TELEGRAM_BOT_TOKEN || "";
  const maskedToken = currentToken
    ? `${currentToken.slice(0, 8)}...${currentToken.slice(-4)}`
    : "not set";

  console.log(`Current Bot Token: ${maskedToken}`);
  const newToken = await prompt(
    "Enter Telegram Bot Token (or press enter to keep current)",
  );

  if (newToken) {
    env.TELEGRAM_BOT_TOKEN = newToken;
  }

  saveEnv(env);
  console.log("\n✓ Telegram configuration saved");
}

// Configure browser settings
async function configureBrowser(_env: Record<string, string>): Promise<void> {
  console.log("\n=== Browser Configuration (agent-browser) ===\n");
  console.log("agent-browser manages the browser daemon automatically.");
  console.log("No configuration is required.");
  console.log("\nTo install: npm install -g agent-browser");
  console.log("The daemon starts on first use and stops when the bot exits.");
}

// Customize cogs
async function customizeCogs(): Promise<void> {
  console.log("\n=== Cog Customization ===\n");
  console.log("Available cogs:");
  console.log("  1. identity - Personality and communication style");
  console.log("  2. memory - Memory system behavior");
  console.log("  3. runtime - Environment and capabilities");
  console.log("  4. soul - Persona and behavioral boundaries");
  console.log("\nEnter a number to edit, or press enter to skip");

  const choice = await prompt("Select cog");

  const cogMap: Record<string, string> = {
    "1": "identity",
    "2": "memory",
    "3": "runtime",
    "4": "soul",
  };

  const cogName = cogMap[choice];
  if (!cogName) {
    console.log("Skipping cog customization");
    return;
  }

  const cogPath = join(COGS_PATH, `${cogName}.md`);
  if (!existsSync(cogPath)) {
    console.log(`✗ Cog file not found: ${cogPath}`);
    return;
  }

  const currentContent = readFileSync(cogPath, "utf-8");
  console.log(`\nCurrent content:\n${"=".repeat(40)}`);
  console.log(currentContent);
  console.log("=".repeat(40));

  console.log("\nEnter new content (Ctrl+D or empty line to finish):");

  const stdin = process.stdin;
  const lines: string[] = [];

  stdin.setRawMode?.(false);
  stdin.resume();
  stdin.setEncoding("utf8");

  await new Promise<void>((resolve) => {
    const rl = require("readline").createInterface({
      input: stdin,
      output: process.stdout,
    });

    rl.on("line", (line: string) => {
      if (
        line.trim() === "" &&
        lines.length > 0 &&
        lines[lines.length - 1] === ""
      ) {
        rl.close();
      } else {
        lines.push(line);
      }
    });

    rl.on("close", () => {
      resolve();
    });
  });

  const newContent = lines.join("\n");
  if (newContent.trim()) {
    writeFileSync(cogPath, newContent);
    console.log("\n✓ Cog updated");
  } else {
    console.log("\nNo changes made");
  }
}

// Generate pairing code
async function generatePairing(): Promise<void> {
  console.log("\n=== Generate Pairing Code ===\n");

  const existingData = loadPairingData();
  if (existingData && !existingData.used) {
    const remaining = getPairingCodeRemainingMinutes();
    console.log(`Existing pairing code: ${existingData.code}`);
    console.log(`Expires in: ${remaining} minutes`);
    console.log("\nUse this code as the first message to the bot on Telegram.");
    return;
  }

  // clear any existing pairing (expired or used) before generating a new code
  // this allows re-pairing after expiration or when switching users
  if (existingData) {
    clearPairingForNewCode();
  }

  const code = generatePairingCode();
  await savePairingCodeAsync(code, 60); // 60 minute expiration

  console.log(`\n🔐 Pairing Code: ${code}`);
  console.log("\nInstructions:");
  console.log("1. Open Telegram and find your bot");
  console.log("2. Send this exact code as your first message");
  console.log("3. The bot will confirm pairing and you can start chatting");
  console.log("\n⚠️  This code expires in 60 minutes");
}

// Reset pairing
async function resetPairing(): Promise<void> {
  console.log("\n=== Reset Pairing ===\n");
  clearPairing();
  console.log("✓ Pairing reset. Generate a new code to pair again.");
}
// Generate iMessage pairing code
async function generateImessagePairing(): Promise<void> {
  console.log("\n=== Generate iMessage Pairing Code ===\n");

  const existingData = loadImessagePairingData();
  if (existingData && !existingData.used) {
    const remaining = getImessagePairingCodeRemainingMinutes();
    console.log(`Existing pairing code: ${existingData.code}`);
    console.log(`Expires in: ${remaining} minutes`);
    console.log(
      "\nSend this code via iMessage to your Sendblue number to pair.",
    );
    return;
  }

  if (existingData) {
    clearImessagePairingForNewCode();
  }

  const code = generateImessagePairingCode();
  await saveImessagePairingCodeAsync(code, 60);

  console.log(`\nPairing Code: ${code}`);
  console.log("\nInstructions:");
  console.log(
    "1. Make sure SENDBLUE_API_KEY and SENDBLUE_API_SECRET are set in .env",
  );
  console.log("2. Start the bot with 'bun run start'");
  console.log(
    "3. Send this exact code via iMessage to your Sendblue phone number",
  );
  console.log("4. The bot will confirm pairing and you can start chatting");
  console.log("\nThis code expires in 60 minutes");
}

// Reset iMessage pairing
async function resetImessagePairing(): Promise<void> {
  console.log("\n=== Reset iMessage Pairing ===\n");
  clearImessagePairing();
  console.log(
    "\u2713 iMessage pairing reset. Generate a new code to pair again.",
  );
}

// Configure SendBlue settings
async function configureSendblue(env: Record<string, string>): Promise<void> {
  console.log("\n=== SendBlue / iMessage Configuration ===\n");

  const currentKey = env.SENDBLUE_API_KEY || "";
  const maskedKey = currentKey
    ? `${currentKey.slice(0, 8)}...${currentKey.slice(-4)}`
    : "not set";

  console.log(`Current API Key: ${maskedKey}`);
  const newKey = await prompt(
    "Enter SendBlue API Key (or press enter to keep current)",
  );
  if (newKey) env.SENDBLUE_API_KEY = newKey;

  const currentSecret = env.SENDBLUE_API_SECRET || "";
  const maskedSecret = currentSecret
    ? `${currentSecret.slice(0, 8)}...${currentSecret.slice(-4)}`
    : "not set";

  console.log(`\nCurrent API Secret: ${maskedSecret}`);
  const newSecret = await prompt(
    "Enter SendBlue API Secret (or press enter to keep current)",
  );
  if (newSecret) env.SENDBLUE_API_SECRET = newSecret;

  console.log(
    `\nCurrent From Number: ${env.SENDBLUE_FROM_NUMBER || "not set (sendblue will auto-assign)"}`,
  );
  const newFrom = await prompt(
    "Enter From Number in E.164 format e.g. +15551234567 (or press enter to skip)",
  );
  if (newFrom) env.SENDBLUE_FROM_NUMBER = newFrom;

  console.log(
    `\nCurrent Webhook Port: ${env.SENDBLUE_WEBHOOK_PORT || "3847 (default)"}`,
  );
  const newPort = await prompt(
    "Enter Webhook Port (or press enter to keep default 3847)",
  );
  if (newPort) env.SENDBLUE_WEBHOOK_PORT = newPort;

  saveEnv(env);
  console.log("\n\u2713 SendBlue configuration saved");
}
// Run environment validation
async function runValidation(env: Record<string, string>): Promise<void> {
  console.log("\n=== Environment Validation ===\n");

  // Check API key
  process.stdout.write("Checking API key... ");
  if (env.OPENAI_API_KEY) {
    const valid = await validateOpenAIConnection(
      env.OPENAI_API_KEY,
      env.OPENAI_BASE_URL,
    );
    console.log(
      `${checkmark(valid)} ${valid ? "Connected" : "Failed to connect"}`,
    );
  } else {
    console.log(`${checkmark(false)} Not configured`);
  }

  // Check Telegram token
  process.stdout.write("Checking Telegram token... ");
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await response.json()) as any;
      if (data.ok) {
        console.log(`${checkmark(true)} Connected (@${data.result.username})`);
      } else {
        console.log(`${checkmark(false)} Invalid token`);
      }
    } catch {
      console.log(`${checkmark(false)} Connection failed`);
    }
  } else {
    console.log(`${checkmark(false)} Not configured`);
  }

  // Check browser
  process.stdout.write("Checking browser installation... ");
  const browserOk = await validateBrowser();
  console.log(
    `${checkmark(browserOk)} ${browserOk ? "Ready" : "Not installed"}`,
  );

  // Check cogs
  process.stdout.write("Checking cogs... ");
  const requiredCogs = ["identity", "memory", "runtime", "soul"];
  const missingCogs = requiredCogs.filter(
    (cog) => !existsSync(join(COGS_PATH, `${cog}.md`)),
  );
  console.log(
    `${checkmark(missingCogs.length === 0)} ${missingCogs.length === 0 ? "All present" : `Missing: ${missingCogs.join(", ")}`}`,
  );

  // Check pairing status
  process.stdout.write("Checking Telegram pairing... ");
  const pairingData = loadPairingData();
  if (pairingData?.used) {
    console.log(
      `${checkmark(true)} Paired with user ${pairingData.pairedUserId}`,
    );
  } else if (pairingData?.code) {
    const remaining = getPairingCodeRemainingMinutes();
    if (remaining && remaining > 0) {
      console.log(
        `${checkmark(true)} Code generated (${remaining}m remaining)`,
      );
    } else {
      console.log(`${checkmark(false)} Code expired`);
    }
  } else {
    console.log(`${checkmark(false)} Not paired`);
  }

  // Check SendBlue configuration
  process.stdout.write("Checking SendBlue config... ");
  if (env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET) {
    console.log(`${checkmark(true)} API credentials configured`);
  } else {
    console.log(`${checkmark(false)} Not configured (optional)`);
  }

  // Check iMessage pairing status
  process.stdout.write("Checking iMessage pairing... ");
  const imsgData = loadImessagePairingData();
  if (imsgData?.used) {
    console.log(`${checkmark(true)} Paired with ${imsgData.pairedPhone}`);
  } else if (imsgData?.code) {
    const remaining = getImessagePairingCodeRemainingMinutes();
    if (remaining && remaining > 0) {
      console.log(
        `${checkmark(true)} Code generated (${remaining}m remaining)`,
      );
    } else {
      console.log(`${checkmark(false)} Code expired`);
    }
  } else {
    console.log(`${checkmark(false)} Not paired (optional)`);
  }

  console.log("\nValidation complete");
}

// Main menu
async function mainMenu(): Promise<void> {
  const env = loadEnv();

  while (true) {
    console.log("\n" + "=".repeat(40));
    console.log("Agent Setup & Configuration");
    console.log("=".repeat(40));
    console.log("1. Configure API Settings");
    console.log("2. Configure Telegram Bot");
    console.log("3. Configure Browser Settings");
    console.log("4. Configure SendBlue / iMessage");
    console.log("5. Customize Cogs");
    console.log("6. Generate Telegram Pairing Code");
    console.log("7. Reset Telegram Pairing");
    console.log("8. Generate iMessage Pairing Code");
    console.log("9. Reset iMessage Pairing");
    console.log("10. Run Validation");
    console.log("11. Exit");
    console.log("=".repeat(40));

    const choice = await prompt("Select option");

    switch (choice.trim()) {
      case "1":
        await configureAPI(env);
        break;
      case "2":
        await configureTelegram(env);
        break;
      case "3":
        await configureBrowser(env);
        break;
      case "4":
        await configureSendblue(env);
        break;
      case "5":
        await customizeCogs();
        break;
      case "6":
        await generatePairing();
        break;
      case "7":
        await resetPairing();
        break;
      case "8":
        await generateImessagePairing();
        break;
      case "9":
        await resetImessagePairing();
        break;
      case "10":
        await runValidation(env);
        break;
      case "11":
        console.log("\nGoodbye!");
        process.exit(0);
        break;
      default:
        console.log("\nInvalid option");
    }
  }
}

// Run if called directly
if (import.meta.main) {
  mainMenu().catch(console.error);
}
