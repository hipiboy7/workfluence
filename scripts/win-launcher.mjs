// F-009 체험 묶음을 여는 스크립트 — 묶음 안의 app\launcher.mjs로 돈다(scripts/win-bundle.ts가 넣는다). Node 기본 모듈만 쓴다.
//   start [--no-browser] : 처음이면 설정·데이터베이스·첫 관리자를 만든다. 데이터베이스와 앱을 띄우고 브라우저를 연다. Ctrl+C·창 닫기로 둘 다 멈춘다
//   stop                 : 남은 앱과 데이터베이스를 멈춘다(창을 그냥 닫았을 때)
// 데이터베이스는 pg_ctl로 띄운다 — 관리자 권한 창에서도 뜬다(scripts/dev-db.ts와 같은 까닭). 데이터는 묶음 안의 data\에 남는다.
/* global process, console, setTimeout, fetch -- Node가 주는 것들(이 파일은 묶음 안에서 Node로만 돈다) */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(APP);
const API = join(APP, 'api');
const BIN = join(ROOT, 'pgsql', 'bin');
const DATA = join(ROOT, 'data');
const PGDATA = join(DATA, 'pgdata');
const SETTINGS = join(DATA, 'settings.env');
const PIDFILE = join(DATA, 'launcher.pid');
// 첫 관리자를 만들었다는 표시 — 처음 실행이 중간에 멈춰도 다음 실행이 이어서 만든다
const SEEDED = join(DATA, 'seeded');
// 처음 설정의 기본값 — 만든 뒤에는 data\settings.env가 정한다. 데이터베이스는 개발용(5433)과 겹치지 않는 자리
const DEFAULT_DB_PORT = 5439;
const DEFAULT_APP_PORT = 3000;
// DLL을 찾지 못하면 Windows가 돌려주는 종료 코드(STATUS_DLL_NOT_FOUND)
const DLL_NOT_FOUND = 3221225781;

const exe = (name) => join(BIN, `${name}.exe`);
const say = (s) => console.log(`[체험] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`[체험] ${msg}`);
  process.exit(1);
}

// PostgreSQL은 Windows의 코드 페이지로 경로를 읽는다 — 그 코드 페이지에 없는 글자(영어 Windows의 한글 등)가 든 경로에서는 뜨지 않는다(F-009 러너 실측)
const PATH_HINT = /[^ -~]/.test(ROOT) ? ' — 이 폴더의 경로에 영문이 아닌 글자가 있다. C:\\workfluence 같은 영문 경로로 옮겨 다시 누른다' : '';

function runOrFail(cmd, args, msg, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) fail(`${msg} — ${r.error.message}`);
  if (r.status === DLL_NOT_FOUND) fail(`${msg} — VC++ 런타임 DLL을 찾지 못했다(pgsql\\bin). 묶음을 새로 받아 푼다`);
  if (r.status !== 0) fail(`${msg} (종료 코드 ${r.status})${opts.hint ?? ''}`);
}

/** 앱의 데이터베이스가 없으면 만든다 — 묶음의 PostgreSQL에는 createdb가 없어 api의 pg로 한다(scripts/dev-db.ts와 같다) */
async function ensureDatabase(settings) {
  const { Client } = createRequire(join(API, 'package.json'))('pg');
  const client = new Client({
    host: '127.0.0.1',
    port: Number(settings.WF_PG_EMBEDDED_PORT),
    user: 'workfluence',
    password: settings.WF_PG_EMBEDDED_PASSWORD,
    database: 'postgres',
  });
  await client.connect();
  try {
    if (!(await client.query("SELECT 1 FROM pg_database WHERE datname = 'workfluence'")).rowCount) await client.query('CREATE DATABASE workfluence');
  } finally {
    await client.end();
  }
}

/** KEY=VALUE 한 줄씩. 따옴표로 싼 값은 벗긴다 */
function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) v = v.slice(1, -1);
    env[line.slice(0, i).trim()] = v;
  }
  return env;
}

/** 처음 실행 — `.env.example`을 바탕으로 비밀 값을 무작위로 만든다. 비밀은 이 파일에만 있다 */
function createSettings() {
  const s = parseEnv(readFileSync(join(APP, 'env.example'), 'utf8'));
  const dbPassword = randomBytes(18).toString('base64url');
  Object.assign(s, {
    // production이면 쿠키에 Secure가 붙어 http로 로그인하지 못한다(체험 가이드 4.2절)
    WF_ENV: 'development',
    WF_PORT: String(DEFAULT_APP_PORT),
    WF_LOG_LEVEL: 'warn',
    WF_SERVE_WEB: 'true',
    WF_WEB_DIST: '../web/dist',
    WF_DATABASE_URL: `postgres://workfluence:${dbPassword}@127.0.0.1:${DEFAULT_DB_PORT}/workfluence`,
    WF_DATABASE_URL_TEST: `postgres://workfluence:${dbPassword}@127.0.0.1:${DEFAULT_DB_PORT}/workfluence_test`,
    WF_DB_AUTO_MIGRATE: 'false',
    WF_PG_EMBEDDED_DIR: PGDATA,
    WF_PG_EMBEDDED_PORT: String(DEFAULT_DB_PORT),
    WF_PG_EMBEDDED_PASSWORD: dbPassword,
    WF_SESSION_SECRET: randomBytes(32).toString('hex'),
    WF_ROOT_PASSWORD: `Wf-${randomBytes(9).toString('base64url')}`,
    WF_STORAGE_PATH: join(DATA, 'attachments'),
    WF_LLM_MASTER_KEY: randomBytes(32).toString('base64'),
  });
  const lines = ['# workfluence 체험 설정 — 처음 실행에서 만들었다. 비밀 값이 들어 있다(이 폴더 밖으로 보내지 않는다)'];
  for (const [k, v] of Object.entries(s)) lines.push(`${k}=${/[\s#'"{}]/.test(v) ? `'${v}'` : v}`);
  mkdirSync(DATA, { recursive: true });
  writeFileSync(SETTINGS, lines.join('\r\n') + '\r\n');
}

/** 앱과 표 만들기에 넘길 환경 — 이 컴퓨터에 남은 WF_ 변수는 뺀다(앱의 설정 검사는 모르는 WF_ 키가 있으면 뜨지 않는다) */
function childEnv(settings) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('WF_')) env[k] = v;
  return { ...env, ...settings };
}

/**
 * 앱 부품(node_modules)의 폴더 연결을 만든다 — zip은 연결을 담지 못해 묶을 때 목록(links.json)으로 적어 두었다(scripts/win-bundle.ts).
 * 없거나 다른 곳(폴더를 옮기기 전 자리)을 가리키면 다시 만든다. junction은 관리자 권한 없이 만든다
 */
function ensureLinks() {
  const file = join(APP, 'links.json');
  if (!existsSync(file)) return;
  let made = 0;
  for (const { path, target } of JSON.parse(readFileSync(file, 'utf8'))) {
    const p = join(API, path);
    const t = join(API, target);
    try {
      if (resolve(readlinkSync(p)).toLowerCase() === t.toLowerCase()) continue;
      try {
        unlinkSync(p);
      } catch {
        rmdirSync(p);
      }
    } catch {
      // 아직 없다
    }
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(t, p, 'junction');
    made++;
  }
  if (made) say(`앱 부품의 연결 ${made}개를 만들었다`);
}

const dbRunning = () => spawnSync(exe('pg_ctl'), ['status', '-D', PGDATA], { stdio: 'ignore' }).status === 0;

function stopDatabase() {
  if (existsSync(join(PGDATA, 'PG_VERSION')) && dbRunning()) spawnSync(exe('pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast', '-w'], { stdio: 'inherit' });
}

async function start(openBrowser) {
  ensureLinks();
  const first = !existsSync(SETTINGS);
  if (first) createSettings();
  const settings = parseEnv(readFileSync(SETTINGS, 'utf8'));
  const dbPort = settings.WF_PG_EMBEDDED_PORT;
  const appPort = settings.WF_PORT;
  const env = childEnv(settings);

  const fresh = !existsSync(join(PGDATA, 'PG_VERSION'));
  if (fresh) {
    say('처음이라 데이터베이스를 만든다 — 1~2분 걸린다');
    const pw = join(DATA, 'pw.tmp');
    writeFileSync(pw, settings.WF_PG_EMBEDDED_PASSWORD);
    try {
      runOrFail(exe('initdb'), ['-D', PGDATA, '-U', 'workfluence', `--pwfile=${pw}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], '데이터베이스를 만들지 못했다', {
        hint: PATH_HINT,
      });
    } finally {
      rmSync(pw, { force: true });
    }
  }
  if (dbRunning()) say('데이터베이스가 이미 떠 있다 — 그대로 쓴다');
  else {
    runOrFail(exe('pg_ctl'), ['start', '-D', PGDATA, '-o', `-p ${dbPort}`, '-l', join(DATA, 'postgres.log'), '-w', '-t', '120'], `데이터베이스를 띄우지 못했다 — ${join(DATA, 'postgres.log')}를 본다`, {
      hint: PATH_HINT,
    });
  }
  try {
    await ensureDatabase(settings);
  } catch (e) {
    fail(`데이터베이스(workfluence)를 만들지 못했다 — ${e instanceof Error ? e.message : String(e)}`);
  }
  runOrFail(process.execPath, [join(API, 'dist', 'db', 'migrate.js')], '표를 만들지 못했다', { cwd: API, env });
  const seeding = !existsSync(SEEDED);
  if (seeding) {
    runOrFail(process.execPath, [join(API, 'dist', 'db', 'seed.js')], '첫 관리자를 만들지 못했다', { cwd: API, env });
    writeFileSync(SEEDED, new Date().toISOString());
  }

  writeFileSync(PIDFILE, String(process.pid));
  const app = spawn(process.execPath, ['--enable-source-maps', join(API, 'dist', 'main.js')], { cwd: API, env, stdio: 'inherit' });
  let stopping = false;
  const shutdown = (code) => {
    if (stopping) return;
    stopping = true;
    say('멈추는 중…');
    if (app.exitCode === null) app.kill();
    stopDatabase();
    rmSync(PIDFILE, { force: true });
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(0));
  app.on('exit', (code) => {
    if (!stopping) {
      say(`앱이 끝났다 (종료 코드 ${code})`);
      shutdown(code ?? 1);
    }
  });

  const url = `http://127.0.0.1:${appPort}`;
  for (let i = 0; i < 120 && !stopping; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        say(`위키가 떴다 — 브라우저에서 ${url}`);
        if (seeding) say(`처음 로그인: 아이디 ${settings.WF_ROOT_USERNAME} / 비밀번호 ${settings.WF_ROOT_PASSWORD}  (첫 로그인에서 바꾸게 된다)`);
        say('멈추려면 이 창에서 Ctrl+C (창을 그냥 닫았으면 멈추기.cmd)');
        if (openBrowser) spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    } catch {
      // 아직 뜨는 중이다
    }
    await sleep(1000);
  }
  if (!stopping) {
    say('앱이 2분 안에 답하지 않았다 — 위의 줄을 본다');
    shutdown(1);
  }
}

function stop() {
  if (existsSync(PIDFILE)) {
    spawnSync('taskkill', ['/PID', readFileSync(PIDFILE, 'utf8').trim(), '/T', '/F'], { stdio: 'ignore' });
    rmSync(PIDFILE, { force: true });
  }
  stopDatabase();
  say('멈췄다');
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'start') await start(!rest.includes('--no-browser'));
else if (command === 'stop') stop();
else fail('쓰는 법: 시작.cmd 또는 멈추기.cmd');
