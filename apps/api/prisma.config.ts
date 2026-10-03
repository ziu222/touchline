import { defineConfig, env } from 'prisma/config';

try {
  process.loadEnvFile('../../.env');
} catch {
  // CI and production inject env directly
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('MIGRATION_DATABASE_URL') },
});
