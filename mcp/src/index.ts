import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connect, migrate } from "./db.js";
import { sweepIdleProfiles } from "./service.js";

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // A missing .env is normal in deployment, where the variables come from the environment.
  }
  const config = loadConfig();
  const db = connect(config.databaseUrl);
  await migrate(db);
  console.info(
    config.bedrock
      ? `[model] Amazon Bedrock ${config.bedrock.modelId} in ${config.bedrock.region}, monthly limit ${config.bedrock.monthlyLimitUsd} USD`
      : "[model] AWS_BEARER_TOKEN_BEDROCK is not set: the rules rank the suggestions alone",
  );

  const sweep = async () => {
    try {
      const n = await sweepIdleProfiles(db, config.profileTtlHours);
      if (n > 0) console.info(`[sweep] ${n} idle profile(s) deleted`);
    } catch (error) {
      console.error("[sweep] could not delete idle profiles:", (error as Error).message);
    }
  };
  await sweep();
  const timer = setInterval(sweep, 15 * 60 * 1000);

  const server = buildApp({ db, config }).listen(config.port, () => console.info(`[http] listening on port ${config.port}`));
  const stop = (signal: string) => {
    console.info(`[http] ${signal} received, shutting down`);
    clearInterval(timer);
    server.close(() => void db.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error) => {
  console.error("[start] the server could not start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
