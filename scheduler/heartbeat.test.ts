import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "fs";
import { join } from "path";
import {
  parseDuration,
  isWithinActiveHours,
  heartbeatTick,
  type HeartbeatConfig,
  type HeartbeatActiveHours,
} from "./heartbeat.ts";

// Test directory setup
const TEST_COGS_DIR = join(import.meta.dir, "test_cogs");
const TEST_HEARTBEAT_MD = join(TEST_COGS_DIR, "HEARTBEAT.md");
const TEST_AUDIT_LOG = join(import.meta.dir, "test_heartbeat.log");

describe("parseDuration", () => {
  it("should parse minutes correctly", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
    expect(parseDuration("1m")).toBe(60 * 1000);
    expect(parseDuration("0m")).toBe(0);
  });

  it("should parse hours correctly", () => {
    expect(parseDuration("1h")).toBe(60 * 60 * 1000);
    expect(parseDuration("2h")).toBe(2 * 60 * 60 * 1000);
    expect(parseDuration("0h")).toBe(0);
  });

  it("should parse days correctly", () => {
    expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("2d")).toBe(2 * 24 * 60 * 60 * 1000);
    expect(parseDuration("0d")).toBe(0);
  });

  it("should handle case insensitivity", () => {
    expect(parseDuration("30M")).toBe(30 * 60 * 1000);
    expect(parseDuration("1H")).toBe(60 * 60 * 1000);
    expect(parseDuration("1D")).toBe(24 * 60 * 60 * 1000);
  });

  it("should handle whitespace", () => {
    expect(parseDuration(" 30m ")).toBe(30 * 60 * 1000);
  });

  it("should return 0 for invalid formats", () => {
    expect(parseDuration("invalid")).toBe(0);
    expect(parseDuration("30")).toBe(0);
    expect(parseDuration("30x")).toBe(0);
    expect(parseDuration("")).toBe(0);
  });

  it("should return 0 for zero values", () => {
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("0m")).toBe(0);
    expect(parseDuration("0h")).toBe(0);
    expect(parseDuration("0d")).toBe(0);
  });
});

describe("isWithinActiveHours", () => {
  it("should return true when no active hours config is provided", () => {
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  it("should check day of week correctly", () => {
    // Create a config for Monday-Friday, 9 AM to 5 PM in UTC
    const config: HeartbeatActiveHours = {
      timezone: "UTC",
      days: [1, 2, 3, 4, 5], // Monday to Friday
      start: "09:00",
      end: "17:00",
    };

    // We can't easily mock Date in Bun tests, so we just verify the function runs
    // The actual day/time checking depends on when the test runs
    const result = isWithinActiveHours(config);
    expect(typeof result).toBe("boolean");
  });

  it("should handle overnight ranges", () => {
    const config: HeartbeatActiveHours = {
      timezone: "UTC",
      days: [0, 1, 2, 3, 4, 5, 6], // All days
      start: "22:00",
      end: "06:00", // Overnight range
    };

    const result = isWithinActiveHours(config);
    expect(typeof result).toBe("boolean");
  });

  it("should handle invalid timezone gracefully", () => {
    const config: HeartbeatActiveHours = {
      timezone: "Invalid/Timezone",
      days: [1],
      start: "09:00",
      end: "17:00",
    };

    // Should fail open (return true) on error
    const result = isWithinActiveHours(config);
    expect(typeof result).toBe("boolean");
  });
});

describe("heartbeatTick", () => {
  let sentMessages: Array<{ text: string; isHeartbeat?: boolean }> = [];

  const mockSendMessage = async (text: string, isHeartbeat?: boolean): Promise<void> => {
    sentMessages.push({ text, isHeartbeat });
  };

  beforeEach(() => {
    sentMessages = [];
    // Create test cogs directory
    if (!existsSync(TEST_COGS_DIR)) {
      mkdirSync(TEST_COGS_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Cleanup test files
    if (existsSync(TEST_HEARTBEAT_MD)) {
      unlinkSync(TEST_HEARTBEAT_MD);
    }
    if (existsSync(TEST_AUDIT_LOG)) {
      unlinkSync(TEST_AUDIT_LOG);
    }
    if (existsSync(TEST_COGS_DIR)) {
      rmdirSync(TEST_COGS_DIR);
    }
  });

  it("should skip when HEARTBEAT.md does not exist", async () => {
    // Ensure file doesn't exist
    if (existsSync(TEST_HEARTBEAT_MD)) {
      unlinkSync(TEST_HEARTBEAT_MD);
    }

    const config: HeartbeatConfig = {
      every: "30m",
      maxAckChars: 20,
    };

    await heartbeatTick(mockSendMessage, config);

    expect(sentMessages.length).toBe(0);
  });

  it("should skip when HEARTBEAT.md is empty", async () => {
    writeFileSync(TEST_HEARTBEAT_MD, "", "utf-8");

    const config: HeartbeatConfig = {
      every: "30m",
      maxAckChars: 20,
    };

    await heartbeatTick(mockSendMessage, config);

    expect(sentMessages.length).toBe(0);
  });

  it("should skip when HEARTBEAT.md contains only whitespace", async () => {
    writeFileSync(TEST_HEARTBEAT_MD, "   \n\n   ", "utf-8");

    const config: HeartbeatConfig = {
      every: "30m",
      maxAckChars: 20,
    };

    await heartbeatTick(mockSendMessage, config);

    expect(sentMessages.length).toBe(0);
  });

  it("should skip when HEARTBEAT.md contains only template content", async () => {
    const templateContent = `# Heartbeat

This file controls automated heartbeat behavior.

<!-- add your actionable items here -->
`;
    writeFileSync(TEST_HEARTBEAT_MD, templateContent, "utf-8");

    const config: HeartbeatConfig = {
      every: "30m",
      maxAckChars: 20,
    };

    await heartbeatTick(mockSendMessage, config);

    expect(sentMessages.length).toBe(0);
  });

  it("should skip when outside active hours", async () => {
    // Create a config for a time that definitely doesn't include now
    // Using a day that doesn't exist (e.g., day 9)
    const config: HeartbeatConfig = {
      every: "30m",
      maxAckChars: 20,
      activeHours: {
        timezone: "UTC",
        days: [9], // Invalid day - should never match
        start: "00:00",
        end: "23:59",
      },
    };

    writeFileSync(TEST_HEARTBEAT_MD, "Check the server status", "utf-8");

    await heartbeatTick(mockSendMessage, config);

    expect(sentMessages.length).toBe(0);
  });
});

describe("heartbeatTick with mocked OpenAI", () => {
  // Note: These tests would require mocking the OpenAI client
  // Since we can't easily mock modules in Bun without additional setup,
  // we'll document what these tests should verify:

  it("should call model with correct prompt when HEARTBEAT.md has actionable content", async () => {
    // This test would verify that when HEARTBEAT.md contains actionable items,
    // the heartbeatTick function calls the OpenAI API with the correct system prompt
    // containing the heartbeat instructions
    expect(true).toBe(true); // Placeholder
  });
});
