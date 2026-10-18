// Reads settings from the environment, loading a local .env file once if there is one.
let loaded = false;

export function env(name: string): string | undefined {
  if (!loaded) {
    loaded = true;
    try {
      process.loadEnvFile(".env");
    } catch (error) {
      // A missing .env is fine when the variables come from the environment.
      console.warn(`[env] no .env file loaded: ${(error as Error).message}`);
    }
  }
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
