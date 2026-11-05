import { createServer, request as proxyRequest } from 'node:http';
import { readFile, writeFile, mkdtemp, rm, stat, mkdir, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import { dropOwnedTestSchema } from './test-schema.mjs';

// Real browser + compiled API + PostgreSQL. Never starts the production SMTP sender.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(process.env.ANITRACK_FRONTEND_DIR || resolve(root, '../ANITRACK-FRONTEND'));
const webRoot = resolve(frontend, 'dist/spa');
const serveOnly = process.argv.slice(2).includes('--serve');
const liveAi = serveOnly && process.env.ANITRACK_TEST_LIVE_AI === '1';
if (process.argv.slice(2).some(arg => arg !== '--serve')) throw new Error('Supported option: --serve');
const infoPath = resolve(frontend, '.tools/native-fixture.json');
const values = { ...parseEnv(readFileSync(resolve(root, '.env'), 'utf8')), ...process.env };
if (values.NODE_ENV === 'production') throw new Error('Browser integration requires a development database.');
if (!values.DATABASE_URL || !values.DIRECT_URL) throw new Error('Configure development database URLs first.');
await stat(resolve(webRoot, 'index.html'));
await stat(resolve(root, 'dist/app.js'));
const schema = 'anitrack_browser_' + randomUUID().replaceAll('-', '');
const scoped = value => {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Use PostgreSQL connections.');
  url.searchParams.set('schema', schema);
  return url.href;
};
const testEnv = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: scoped(values.DATABASE_URL),
  DIRECT_URL: scoped(values.DIRECT_URL)
};
const redact = value => String(value || '')
  .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[redacted database URL]')
  .replace(/[a-z0-9.-]+\.neon\.tech(?::\d+)?/gi, '[database host]')
  .replace(/#token=[^\s"'<>]+/g, '#token=[redacted]');
const run = (args, cwd, env, timeout = 360000) => new Promise((accept, reject) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => { child.kill(); }, timeout);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('exit', code => {
    clearTimeout(timer);
    process.stdout.write(redact(output));
    if (code === 0) accept();
    else reject(new Error('Browser integration command failed (' + code + ').'));
  });
});
const listen = server => new Promise((accept, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => accept(server.address().port));
});
const close = server => new Promise(accept => {
  if (!server?.listening) return accept();
  server.close(accept);
  server.closeAllConnections();
});
const admin = new PrismaClient({ datasourceUrl: values.DIRECT_URL, errorFormat: 'minimal' });
let db, api, web, scratch, created = false, infoCreated = false;
try {
  if (!/^anitrack_browser_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid disposable schema.');
  await admin.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
  created = true;
  console.log('Created this browser run’s isolated schema.');
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], root, testEnv);
  const tables = await admin.$queryRawUnsafe('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1', schema);
  if (!['User', 'Anime', 'WatchlistEntry', 'RefreshSession', 'Collection', 'CollectionItem', 'AccountToken']
    .every(name => tables.some(table => table.tablename === name)))
    throw new Error('The isolated schema is incomplete.');

  scratch = await mkdtemp(resolve(tmpdir(), 'anitrack-browser-'));
  const mailbox = resolve(scratch, 'mailbox.json');
  const sent = [];
  let apiPort;
  web = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const upstream = proxyRequest({
          hostname: '127.0.0.1', port: apiPort, path: req.url, method: req.method,
          headers: { ...req.headers, host: '127.0.0.1:' + apiPort }
        }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(upstream);
        return;
      }
      let target = resolve(webRoot, '.' + pathname);
      const inside = relative(webRoot, target);
      if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) {
        res.writeHead(400); res.end(); return;
      }
      try {
        if (!(await stat(target)).isFile()) target = resolve(webRoot, 'index.html');
      } catch {
        if (extname(pathname)) { res.writeHead(404); res.end(); return; }
        target = resolve(webRoot, 'index.html');
      }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
        '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(target));
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  const webPort = await listen(web);
  const origin = 'http://127.0.0.1:' + webPort;
  db = new PrismaClient({ datasourceUrl: testEnv.DATABASE_URL, errorFormat: 'minimal' });
  const { createApp } = await import('../dist/app.js');
  const { loadConfig } = await import('../dist/config.js');
  const config = { ...loadConfig(), DATABASE_URL: testEnv.DATABASE_URL, DIRECT_URL: testEnv.DIRECT_URL,
    CLIENT_ORIGIN: origin, JWT_SECRET: randomBytes(48).toString('hex'), NODE_ENV: 'test', TRUST_PROXY: '0',
    GEMINI_API_KEY: liveAi ? values.GEMINI_API_KEY : undefined,
    ASSISTANT_DAILY_GENERATIONS: liveAi ? 3 : 0, ASSISTANT_DAILY_BUDGET_USD: 0.5 };
  const mailer = { available: true, async send(to, purpose, token) {
    sent.push({ to, purpose, token });
    await writeFile(mailbox, JSON.stringify(sent), { mode: 0o600 });
  } };
  const fixtureId = randomBytes(16).toString('hex');
  const fixture = express();
  fixture.use((_req, res, next) => { res.setHeader('X-AniTrack-Test-Fixture', fixtureId); next(); });
  fixture.use(express.json({ limit: '2mb', inflate: false }));
  fixture.post('/api/auth/register', (req, res, next) => {
    if (typeof req.body?.email !== 'string' || !req.body.email.endsWith('@example.test')) {
      res.status(400).json({ error: { code: 'TEST_ACCOUNT_REQUIRED',
        message: 'This isolated test server accepts disposable example.test accounts only.' } });
      return;
    }
    next();
  });
  fixture.use(createApp(db, config, { accountMailer: mailer }));
  api = createServer(fixture);
  apiPort = await listen(api);
  console.log('Testing production SPA + compiled API + isolated PostgreSQL; mail is captured locally.');
  if (serveOnly) {
    await mkdir(dirname(infoPath), { recursive: true });
    await writeFile(infoPath, JSON.stringify({ origin, apiPort, mailbox, fixtureId }), { flag: 'wx', mode: 0o600 });
    infoCreated = true;
    console.log('Native test fixture ready. Connection metadata: ' + infoPath);
    console.log('Send stop on stdin to remove this fixture and its test data.');
    await new Promise(accept => {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      let input = '';
      process.stdin.on('data', chunk => {
        input += chunk;
        if (input.split(/\r?\n/).some(line => line.trim() === 'stop')) accept();
      });
      process.once('SIGINT', accept);
      process.once('SIGTERM', accept);
    });
    process.stdin.pause();
  } else {
    await run([resolve(frontend, 'node_modules/@playwright/test/cli.js'), 'test',
      'e2e/live-account.spec.ts', '--trace', 'off', '--reporter', 'line'], frontend, {
      ...testEnv, ANITRACK_LIVE_SMOKE_URL: origin, ANITRACK_TEST_MAILBOX_FILE: mailbox
    });
    if (await db.user.count() !== 0) throw new Error('The browser journey left disposable account data.');
    console.log('Real browser journey passed; no disposable users remain.');
  }
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  await close(web);
  await close(api);
  await db?.$disconnect();
  try {
    if (created) {
      await dropOwnedTestSchema(admin, schema, created);
      console.log('Removed only this run’s isolated schema.');
    }
  } catch (error) {
    process.exitCode = 1;
    console.error('Cleanup needs retry for owned schema ' + schema + ': ' + redact(error.message));
  } finally {
    await admin.$disconnect();
    if (infoCreated) await unlink(infoPath);
    if (scratch) {
      const checked = resolve(scratch);
      if (dirname(checked) !== resolve(tmpdir()) || !basename(checked).startsWith('anitrack-browser-')) {
        console.error('Refusing cleanup of an unexpected temporary path.');
        process.exitCode = 1;
      } else {
        await rm(checked, { recursive: true, force: true });
        console.log('Removed this run’s captured mail and temporary files.');
      }
    }
  }
}
