try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // CI and production inject env directly
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}
