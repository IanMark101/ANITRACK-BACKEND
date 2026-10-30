import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// Integration tests use a fresh schema, never the application's tables.
const values = { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };
if (values.NODE_ENV === 'production')
  throw new Error('Use a development database to run isolated integration tests.');
if (!values.DATABASE_URL || !values.DIRECT_URL)
  throw new Error('Configure development database URLs first.');
const schema = `anitrack_test_${randomUUID().replaceAll('-', '')}`;
const withSchema = (value) => {
  const url = new URL(value);
  url.searchParams.set('schema', schema);
  return url.href;
};
const env = {
  ...values,
  NODE_ENV: 'test',
  DATABASE_URL: withSchema(values.DATABASE_URL),
  DIRECT_URL: withSchema(values.DIRECT_URL),
  TEST_DATABASE_URL: withSchema(values.DATABASE_URL)
};
const db = new PrismaClient({ datasourceUrl: values.DIRECT_URL, errorFormat: 'minimal' });
const redact = (value) =>
  String(value || '')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted database URL]')
    .replace(/[a-z0-9.-]+\.neon\.tech(?::\d+)?/gi, '[Neon host]');
function run(args) {
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 360000 });
  process.stdout.write(redact(result.stdout));
  process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0)
    throw new Error(`Isolated test command failed (${result.status ?? result.error?.code}).`);
}
let created = false;
try {
  if (!/^anitrack_test_[a-f0-9]{32}$/.test(schema))
    throw new Error('Invalid isolated schema name.');
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  created = true;
  console.log('Created a new, isolated test schema.');
  run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  const tables =
    await db.$queryRaw`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = ${schema}`;
  if (
    !['User', 'Anime', 'WatchlistEntry', 'RefreshSession', '_prisma_migrations'].every((name) =>
      tables.some((table) => table.tablename === name)
    )
  )
    throw new Error('The test schema is incomplete; refusing to run tests.');
  run([
    'node_modules/vitest/vitest.mjs',
    'run',
    'test/auth.integration.test.ts',
    'test/discovery.integration.test.ts',
    'test/account.integration.test.ts',
    'test/collections.integration.test.ts',
    '--maxWorkers=1',
    '--testTimeout=120000'
  ]);
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  if (created) {
    // CREATE SCHEMA has no IF NOT EXISTS: this target was created by this invocation.
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    console.log("Removed this invocation's isolated test schema.");
  }
  await db.$disconnect();
}
