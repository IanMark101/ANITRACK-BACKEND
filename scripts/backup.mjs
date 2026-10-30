import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const connection = new URL(process.env.DIRECT_URL || '');
if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('Set a PostgreSQL DIRECT_URL.');
const directory = resolve(process.env.BACKUP_DIR || 'backups');
const target = resolve(directory, `anitrack-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.dump`);
if (dirname(target) !== directory) throw new Error('Invalid backup target.');
mkdirSync(directory, { recursive: true });
const env = { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432',
  PGDATABASE: decodeURIComponent(connection.pathname.slice(1)), PGUSER: decodeURIComponent(connection.username),
  PGPASSWORD: decodeURIComponent(connection.password), PGSSLMODE: connection.searchParams.get('sslmode') || 'require',
  PGCHANNELBINDING: connection.searchParams.get('channel_binding') || 'prefer' };
const result = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--file', target], { env, encoding: 'utf8' });
if (result.error || result.status !== 0) {
  try { unlinkSync(target); } catch { /* Only this invocation's new output can be removed. */ }
  throw new Error(result.error?.code === 'ENOENT' ? 'Install PostgreSQL client tools and add pg_dump to PATH.' : 'Backup failed. Check database connectivity and PostgreSQL client compatibility.');
}
const verify = spawnSync('pg_restore', ['--list', target], { env, encoding: 'utf8' });
if (verify.error || verify.status !== 0) throw new Error('Backup created, but archive verification failed. Do not rely on it until verified.');
console.log(`Created and checked backup archive: ${target}`);
