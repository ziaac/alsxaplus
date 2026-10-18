import { defineConfig } from "@playwright/test";

// The tests start their own copy of the MCP server (port 8082, the rules only, no language model, so every result is
// the same each time) against the test database, and their own copy of this app (port 5299).
try {
  process.loadEnvFile("../mcp/.env");
} catch {
  // the variables may come from the environment
}

const testDatabase = process.env.TEST_DATABASE_URL ?? "";
const serviceKey = process.env.SERVICE_KEY ?? "test-service-key";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5299", viewport: { width: 1280, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  outputDir: "test-results",
  webServer: [
    {
      command: "npx tsx src/index.ts",
      cwd: "../mcp",
      url: "http://127.0.0.1:8082/health",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DATABASE_URL: testDatabase, PORT: "8082", SERVICE_KEY: serviceKey, AWS_BEARER_TOKEN_BEDROCK: "", PROFILE_TTL_HOURS: "24" },
    },
    {
      command: "npx react-router dev --port 5299 --host 127.0.0.1",
      url: "http://127.0.0.1:5299/",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { MCP_URL: "http://127.0.0.1:8082", SERVICE_KEY: serviceKey, DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY ?? "", DISABLE_LIMITS: "true" },
    },
  ],
});
