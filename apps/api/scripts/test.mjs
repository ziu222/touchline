// Runs the API tests against a fresh `touchline_test` database, created and migrated per run.
// Tests never touch dev data, and append-only tables (stage_history, audit_log) need no cleanup.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // CI injects env directly
}

const DB = 'touchline_test';
const withDb = (url, db) => Object.assign(new URL(url), { pathname: `/${db}` }).toString();

const admin = new pg.Client({ connectionString: withDb(process.env.MIGRATION_DATABASE_URL, 'postgres') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();

const env = {
  ...process.env,
  MIGRATION_DATABASE_URL: withDb(process.env.MIGRATION_DATABASE_URL, DB),
  DATABASE_URL: withDb(process.env.DATABASE_URL, DB),
};
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });

run('prisma', ['migrate', 'deploy']);
run('tsc', ['-p', 'tsconfig.json']);
run('node', ['--test', 'dist/**/*.test.js']);
