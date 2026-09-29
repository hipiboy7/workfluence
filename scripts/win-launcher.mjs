// F-009 체험 묶음을 여는 스크립트 — 묶음 안의 app\launcher.mjs로 돈다(scripts/win-bundle.ts가 넣는다). Node 기본 모듈만 쓴다.
//   start [--no-browser] : 처음이면 설정·데이터베이스·첫 관리자를 만든다. 데이터베이스와 앱을 띄우고 브라우저를 연다. Ctrl+C·창 닫기로 둘 다 멈춘다.
//                          이미 떠 있으면 브라우저만 열고 끝낸다
//   stop                 : 남은 앱과 데이터베이스를 멈춘다(창을 그냥 닫았을 때)
// 데이터베이스는 pg_ctl로 띄운다 — 관리자 권한 창에서도 뜬다(scripts/dev-db.ts와 같은 까닭). 데이터는 묶음 안의 data\에 남는다.
// 설정 키의 이름(WF_*)을 여기서 쓴다 — 키를 더하거나 바꾸면 이 파일도 같이 고친다(CLAUDE.md 5절).
/* global process, console, setTimeout, fetch, AbortSignal, Buffer -- Node가 주는 것들(이 파일은 묶음 안에서 Node로만 돈다) */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
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
// initdb가 끝까지 갔다는 표시 — PG_VERSION은 initdb가 처음에 써서 반쯤 만든 데이터베이스와 가리지 못한다
const PG_READY = join(DATA, 'pgdata.ready');
// 앞선 판이 쓰던 표시(첫 관리자를 만들었다). 지금은 "그 데이터베이스는 다 만들어졌다"의 증거로만 읽는다
const LEGACY_SEEDED = join(DATA, 'seeded');
const SYS32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
// 처음 설정의 기본값 — 만든 뒤에는 data\settings.env가 정한다. 데이터베이스는 개발용(5433)과 겹치지 않는 자리
const DEFAULT_DB_PORT = 5439;
const DEFAULT_APP_PORT = 3000;
// DLL을 찾지 못하면 Windows가 돌려주는 종료 코드(STATUS_DLL_NOT_FOUND)
const DLL_NOT_FOUND = 3221225781;
// Windows 탐색기가 다루는 경로 길이의 끝(MAX_PATH 260 — 끝의 NUL 한 자를 뺀다)
const MAX_PATH = 259;
// 다른 실행이 PID 파일을 막 만들어 아직 번호를 쓰지 않았을 수 있는 시간
const FRESH_LOCK_MS = 30_000;

const exe = (name) => join(BIN, `${name}.exe`);
const say = (s) => console.log(`[체험] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e instanceof Error ? e.message : String(e));

// 이 실행이 맡은 것 — 멈출 때 이것만 치운다. 다른 실행이 띄운 데이터베이스를 멈추지 않는다
const state = { lock: false, ownDb: false, app: null, stopping: false };

function cleanup() {
  const app = state.app;
  if (app && app.exitCode === null && app.signalCode === null) app.kill();
  if (state.ownDb && stopDatabase() === 'failed') console.error(`[체험] 데이터베이스를 멈추지 못했다 — 멈추기.cmd를 누른다`);
  if (state.lock) rmSync(PIDFILE, { force: true });
}

function fail(msg) {
  console.error(`[체험] ${msg}`);
  if (!state.stopping) {
    state.stopping = true;
    cleanup();
  }
  process.exit(1);
}

function shutdown(code) {
  if (state.stopping) return;
  state.stopping = true;
  say('멈추는 중…');
  cleanup();
  process.exit(code);
}

// PostgreSQL은 Windows의 코드 페이지로 경로를 읽는다 — 그 코드 페이지에 없는 글자(영어 Windows의 한글 등)가 든 경로에서는 뜨지 않는다(F-009 러너 실측)
const PATH_HINT = /[^ -~]/.test(ROOT) ? ' — 이 폴더의 경로에 영문이 아닌 글자가 있다. 멈추기.cmd를 누른 뒤 C:\\wf 같은 짧은 영문 경로로 옮겨 다시 누른다' : '';

function runOrFail(cmd, args, msg, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) fail(`${msg} — ${r.error.message}`);
  if (r.status === DLL_NOT_FOUND) fail(`${msg} — VC++ 런타임 DLL을 찾지 못했다(pgsql\\bin). 묶음을 새로 받아 푼다`);
  if (r.status !== 0) fail(`${msg} (종료 코드 ${r.status})${opts.hint ?? ''}`);
  return r;
}

/** 파일 쓰기 — 실패하면 까닭을 말한다(쓰기 권한이 없는 자리 등) */
function writeOrFail(path, text) {
  try {
    writeFileSync(path, text);
  } catch (e) {
    fail(`${path}에 쓰지 못했다(${e.code ?? errText(e)}) — 이 폴더에 쓸 수 없는 자리다. C:\\wf 같은 내 폴더(짧은 영문 경로)에 새로 푼다`);
  }
}

/**
 * 이 묶음의 node.exe로 도는 다른 프로세스 — [{ pid, kind }]. kind: 'start'(여는 스크립트의 start) · 'app'(앱) · 'other'. 알 수 없으면 null.
 * 실행 파일 경로(ExecutablePath)가 지금 이 node.exe와 같은 것만 본다 — 다른 폴더의 묶음, 이 PC의 다른 Node 프로그램은 건드리지 않는다.
 * 경로 비교는 PowerShell 안에서 한다(환경변수로 넘긴다 — 한글 경로가 출력 인코딩을 거치지 않는다)
 */
function bundleProcesses() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$c = [StringComparison]::OrdinalIgnoreCase',
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $env:TRIAL_NODE, $c) } | ForEach-Object {",
    '  $cl = [string]$_.CommandLine',
    "  $k = if ($cl.IndexOf('\\api\\dist\\main.js', $c) -ge 0) { 'app' } elseif ($cl.IndexOf('\\app\\launcher.mjs', $c) -ge 0 -and $cl -match '\\sstart(\\s|$)') { 'start' } else { 'other' }",
    "  '{0} {1}' -f $_.ProcessId, $k",
    '}',
  ].join('\n');
  const r = spawnSync(join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, TRIAL_NODE: process.execPath },
    windowsHide: true,
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(' '))
    .filter(([pid, kind]) => /^\d+$/.test(pid ?? '') && kind)
    .map(([pid, kind]) => ({ pid: Number(pid), kind }))
    .filter((p) => p.pid !== process.pid);
}

const taskkill = (pid) => spawnSync(join(SYS32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).status === 0;

/** PID 파일의 번호 — 없거나 읽지 못하면 null */
function lockPid() {
  try {
    const n = Number(readFileSync(PIDFILE, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 이 실행이 띄우는 것으로 PID 파일을 잡는다(없을 때만 만든다 — 두 번 눌러도 하나만 뜬다).
 * 이미 있으면 그 번호가 **이 묶음의 여는 스크립트(start)로 살아 있는지** 본다 — 아니면 낡은 파일이라 치우고 다시 잡는다.
 * 돌려주는 값: null(잡았다) 또는 떠 있는 실행의 PID('?'면 확인하지 못했지만 떠 있는 것으로 본다)
 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(PIDFILE, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      state.lock = true;
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') fail(`${PIDFILE}을 만들지 못했다(${e.code ?? errText(e)}) — 이 폴더에 쓸 수 없는 자리다. C:\\wf 같은 내 폴더(짧은 영문 경로)에 새로 푼다`);
    }
    const pid = lockPid();
    if (pid === null) {
      // 번호가 아직 없다 — 다른 실행이 막 만든 참이면 떠 있는 것으로 본다
      let age = Infinity;
      try {
        age = Date.now() - statSync(PIDFILE).mtimeMs;
      } catch {
        // 그새 지워졌다
      }
      if (age < FRESH_LOCK_MS) return '?';
    } else {
      const procs = bundleProcesses();
      if (procs === null) {
        // 확인할 길이 없다 — 그 번호가 아직 node.exe면 떠 있는 것으로 본다(끝내지는 않는다)
        const t = spawnSync(join(SYS32, 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        if (/"node\.exe"/i.test(t.stdout ?? '')) return pid;
      } else if (procs.some((p) => p.pid === pid && p.kind === 'start')) return pid;
    }
    say('지난 실행이 남긴 data\\launcher.pid를 치운다(그 번호는 이 묶음의 실행이 아니다)');
    rmSync(PIDFILE, { force: true });
  }
  return '?';
}

/** 앞서 끝나지 않고 남은 이 묶음의 앱(여는 스크립트는 죽고 앱만 남은 것)을 멈춘다 — 3000번을 쥐고 있다 */
function stopOrphanApps() {
  const procs = bundleProcesses();
  if (!procs) return;
  for (const p of procs.filter((q) => q.kind === 'app')) {
    say(`앞서 남은 이 묶음의 앱(PID ${p.pid})을 멈춘다`);
    taskkill(p.pid);
  }
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

const envLine = (k, v) => `${k}=${/[\s#'"{}]/.test(v) ? `'${v}'` : v}`;

/**
 * data\ 에는 비밀 값(settings.env)과 데이터베이스가 든다 — 상속을 끊고 지금 사용자·SYSTEM·Administrators만 둔다.
 * C:\ 바로 아래 폴더는 다른 로컬 계정도 고칠 수 있게 상속받는다. 실패하면 경고만 한다(체험은 계속된다)
 */
function restrictData() {
  const who = spawnSync(join(SYS32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = /S-1-[\d-]+/.exec(who.stdout ?? '')?.[0];
  const r = sid
    ? spawnSync(join(SYS32, 'icacls.exe'), [DATA, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true })
    : null;
  if (!r || r.status !== 0) say('경고: data 폴더의 권한을 좁히지 못했다 — 이 PC를 다른 사람과 같이 쓰면 data\\settings.env의 비밀 값을 읽을 수 있다');
}

/** 처음 실행 — `.env.example`을 바탕으로 비밀 값을 무작위로 만든다. 비밀은 이 파일에만 있다 */
function createSettings() {
  const s = parseEnv(readFileSync(join(APP, 'env.example'), 'utf8'));
  Object.assign(s, {
    // production이면 쿠키에 Secure가 붙어 http로 로그인하지 못한다(체험 가이드 4.2절)
    WF_ENV: 'development',
    WF_PORT: String(DEFAULT_APP_PORT),
    WF_LOG_LEVEL: 'warn',
    WF_SERVE_WEB: 'true',
    WF_WEB_DIST: '../web/dist',
    WF_DB_AUTO_MIGRATE: 'false',
    WF_PG_EMBEDDED_PORT: String(DEFAULT_DB_PORT),
    WF_PG_EMBEDDED_PASSWORD: randomBytes(18).toString('base64url'),
    WF_SESSION_SECRET: randomBytes(32).toString('hex'),
    WF_ROOT_PASSWORD: `Wf-${randomBytes(9).toString('base64url')}`,
    WF_LLM_MASTER_KEY: randomBytes(32).toString('base64'),
  });
  Object.assign(s, placeKeys(s));
  const lines = ['# workfluence 체험 설정 — 처음 실행에서 만들었다. 비밀 값이 들어 있다(이 폴더 밖으로 보내지 않는다)'];
  lines.push('# 자리(경로)와 데이터베이스 주소는 시작할 때마다 이 폴더의 지금 위치로 다시 쓴다. 자리 번호는 WF_PORT(앱)·WF_PG_EMBEDDED_PORT(데이터베이스)만 고친다');
  for (const [k, v] of Object.entries(s)) lines.push(envLine(k, v));
  mkdirSync(DATA, { recursive: true });
  restrictData();
  writeOrFail(SETTINGS, lines.join('\r\n') + '\r\n');
}

function portOf(settings, key) {
  const n = Number(settings[key]);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`data\\settings.env의 ${key}=${settings[key] ?? ''}가 자리 번호(1~65535)가 아니다`);
  return n;
}

/** 폴더의 지금 위치와 데이터베이스 자리에서 나오는 키 — 폴더를 옮겨도, 자리 번호를 바꿔도 맞게 시작할 때마다 다시 만든다 */
function placeKeys(s) {
  const url = (db) => `postgres://workfluence:${encodeURIComponent(s.WF_PG_EMBEDDED_PASSWORD ?? '')}@127.0.0.1:${s.WF_PG_EMBEDDED_PORT}/${db}`;
  return {
    WF_PG_EMBEDDED_DIR: PGDATA,
    WF_STORAGE_PATH: join(DATA, 'attachments'),
    WF_DATABASE_URL: url('workfluence'),
    WF_DATABASE_URL_TEST: url('workfluence_test'),
  };
}

/** settings.env의 자리 키를 지금 값으로 고쳐 쓴다 — 다른 줄(사람이 고친 값·주석)은 그대로 둔다 */
function syncSettings(text, settings) {
  const want = placeKeys(settings);
  const seen = new Set();
  let changed = false;
  const lines = text.split(/\r?\n/).map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !(m[1] in want)) return line;
    seen.add(m[1]);
    const next = envLine(m[1], want[m[1]]);
    if (next !== line) changed = true;
    return next;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(want))
    if (!seen.has(k)) {
      lines.push(envLine(k, v));
      changed = true;
    }
  if (changed) writeOrFail(SETTINGS, lines.join('\r\n') + '\r\n');
  return { ...settings, ...want };
}

/** 앱과 표 만들기에 넘길 환경 — 이 컴퓨터에 남은 WF_ 변수는 뺀다(앱의 설정 검사는 모르는 WF_ 키가 있으면 뜨지 않는다) */
function childEnv(settings) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('WF_')) env[k] = v;
  return { ...env, ...settings };
}

/** 한 자리가 비었는가 — 'free' · 'busy'(다른 프로그램이 듣는다) · 'denied'(Windows가 막아 둔 자리) */
async function portState(port, host) {
  const listenError = await new Promise((done) => {
    const s = createServer();
    s.once('error', (e) => done(e.code ?? 'ERR'));
    s.listen({ port, host, exclusive: true }, () => s.close(() => done(null)));
  });
  if (listenError === 'EACCES') return 'denied';
  if (listenError) return 'busy';
  // 이 주소로 들을 수 있어도 다른 주소(127.0.0.1만, IPv6)로 누가 듣고 있을 수 있다 — 붙어 본다
  const answered = await new Promise((done) => {
    const c = connect({ port, host: '127.0.0.1' });
    const end = (v) => {
      c.destroy();
      done(v);
    };
    c.once('connect', () => end(true));
    c.once('error', () => end(false));
    c.setTimeout(1500, () => end(false));
  });
  return answered ? 'busy' : 'free';
}

async function requireFreePort(port, host, key, what) {
  const st = await portState(port, host);
  if (st === 'free') return;
  const change = `data\\settings.env의 ${key}=${port}를 다른 수(예: ${port + 100})로 바꿔 저장하고 다시 누른다`;
  if (st === 'denied') fail(`${what} 자리 ${port}번을 Windows가 막아 두었다(Hyper-V·WSL 등이 잡아 두는 범위일 수 있다) — ${change}`);
  fail(`${what} 자리 ${port}번을 다른 프로그램이 쓰고 있다(다른 폴더의 체험 묶음·"가" 길의 pnpm start 등) — 그 프로그램을 끄거나, ${change}`);
}

/**
 * 앱 부품(node_modules)의 폴더 연결을 만든다 — zip은 연결을 담지 못해 묶을 때 목록(links.json)으로 적어 두었다(scripts/win-bundle.ts).
 * 없거나 다른 곳(폴더를 옮기기 전 자리)을 가리키면 다시 만든다. 연결 대신 진짜 폴더가 있으면(탐색기로 복사하면 연결의 내용이 복사된다) 치우고 만든다.
 * junction은 관리자 권한 없이 만든다
 */
function ensureLinks() {
  const file = join(APP, 'links.json');
  if (!existsSync(file)) return;
  let made = 0;
  for (const { path, target } of JSON.parse(readFileSync(file, 'utf8'))) {
    const p = join(API, path);
    const t = join(API, target);
    try {
      let st = null;
      try {
        st = lstatSync(p);
      } catch {
        // 아직 없다
      }
      if (st?.isSymbolicLink()) {
        if (resolve(readlinkSync(p)).toLowerCase() === t.toLowerCase()) continue;
        unlinkSync(p);
      } else if (st) rmSync(p, { recursive: true, force: true });
      mkdirSync(dirname(p), { recursive: true });
      symlinkSync(t, p, 'junction');
      made++;
    } catch (e) {
      fail(
        `앱 부품의 폴더 연결을 만들지 못했다(${e.code ?? errText(e)}: ${path}) — 이 자리에서는 폴더 연결(junction)을 만들 수 없다` +
          '(USB의 FAT32·exFAT, 네트워크 공유, 쓰기 권한이 없는 폴더 등). NTFS 로컬 디스크의 짧은 영문 경로(C:\\wf 등)에 새로 푼다',
      );
    }
  }
  if (made) say(`앱 부품의 연결 ${made}개를 만들었다`);
}

/** 풀린 경로가 탐색기의 한도를 넘는가 — 넘으면 압축 풀기에서 빠진 파일이 있을 수 있다(scripts/win-bundle.ts가 가장 긴 상대 경로를 적는다) */
function warnLongPath() {
  try {
    const { longestPath } = JSON.parse(readFileSync(join(APP, 'bundle.json'), 'utf8'));
    if (Number.isInteger(longestPath) && ROOT.length + 1 + longestPath > MAX_PATH)
      say(`경고: 이 폴더의 경로(${ROOT.length}자)가 길어 압축을 풀 때 빠진 파일이 있을 수 있다 — 뜨지 않으면 C:\\wf 같은 짧은 경로(${MAX_PATH - 1 - longestPath}자 이하)에 새로 푼다`);
  } catch {
    // 표시가 없는 묶음이다
  }
}

const dbRunning = () => existsSync(join(PGDATA, 'PG_VERSION')) && spawnSync(exe('pg_ctl'), ['status', '-D', PGDATA], { stdio: 'ignore' }).status === 0;

/** 'none'(떠 있지 않았다) · 'stopped' · 'failed' */
function stopDatabase() {
  if (!dbRunning()) return 'none';
  const r = spawnSync(exe('pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast', '-w', '-t', '60'], { stdio: 'inherit' });
  return r.status === 0 && !dbRunning() ? 'stopped' : 'failed';
}

/**
 * 데이터베이스가 다 만들어졌는가 — 데이터 폴더가 있고 initdb가 끝났다는 표시가 있어야 한다(`data\pgdata`만 지우면 표시가 남는다 — 그때는 새로 만든다).
 * 표시가 없으면 앞선 판의 흔적(첫 관리자를 만들었다는 표시)으로 본다 — 첫 관리자까지 갔으면 데이터베이스는 다 만들어졌다
 */
function pgReady() {
  if (!existsSync(join(PGDATA, 'PG_VERSION'))) return false;
  if (existsSync(PG_READY)) return true;
  if (existsSync(LEGACY_SEEDED)) {
    writeOrFail(PG_READY, new Date().toISOString());
    return true;
  }
  return false;
}

async function healthy(url, app) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok && (!app || (app.exitCode === null && app.signalCode === null));
  } catch {
    return false;
  }
}

const openBrowserAt = (url) => spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();

async function alreadyRunning(pid, openBrowser) {
  let port = DEFAULT_APP_PORT;
  try {
    port = Number(parseEnv(readFileSync(SETTINGS, 'utf8')).WF_PORT) || port;
  } catch {
    // 설정이 아직 없다 — 먼저 연 실행이 처음 설정을 만드는 중이다
  }
  const url = `http://127.0.0.1:${port}`;
  const up = await healthy(url, null);
  say(`이미 떠 있다${pid === '?' ? '' : ` (PID ${pid})`} — ${up ? `브라우저에서 ${url}` : '아직 뜨는 중이다. 먼저 연 창을 본다'}`);
  say('멈추려면 먼저 연 창에서 Ctrl+C, 창을 닫았으면 멈추기.cmd');
  if (up && openBrowser) openBrowserAt(url);
  if (!up && process.env.TRIAL_NO_PAUSE !== '1') await sleep(5000);
  process.exit(0);
}

async function start(openBrowser) {
  // 신호 처리기는 맨 앞에서 건다 — 데이터베이스를 띄운 뒤라면 어디서 멈춰도 이 실행이 띄운 것을 치운다
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(0));
  if (!existsSync(DATA)) {
    try {
      mkdirSync(DATA, { recursive: true });
    } catch (e) {
      fail(`data 폴더를 만들지 못했다(${e.code ?? errText(e)}) — 이 폴더에 쓸 수 없는 자리다. C:\\wf 같은 내 폴더(짧은 영문 경로)에 새로 푼다`);
    }
  }
  const running = acquireLock();
  if (running !== null) return alreadyRunning(running, openBrowser);
  warnLongPath();
  stopOrphanApps();
  ensureLinks();
  rmSync(join(DATA, 'pw.tmp'), { force: true });

  if (!existsSync(SETTINGS)) {
    if (pgReady())
      fail(
        'data\\settings.env가 없는데 데이터베이스(data\\pgdata)는 있다 — 그 데이터베이스의 비밀번호가 settings.env에만 있었다. ' +
          'settings.env를 되돌리거나, 처음부터 다시 하려면 data 폴더를 통째로 지우고 다시 누른다',
      );
    createSettings();
  }
  let settings = parseEnv(readFileSync(SETTINGS, 'utf8'));
  const dbPort = portOf(settings, 'WF_PG_EMBEDDED_PORT');
  const appPort = portOf(settings, 'WF_PORT');
  settings = syncSettings(readFileSync(SETTINGS, 'utf8'), settings);
  const env = childEnv(settings);

  await requireFreePort(appPort, '0.0.0.0', 'WF_PORT', '앱');
  const dbUp = dbRunning();
  if (!dbUp) await requireFreePort(dbPort, '127.0.0.1', 'WF_PG_EMBEDDED_PORT', '데이터베이스');

  // 떠 있는 데이터베이스는 다 만들어진 것이다(initdb는 서버를 띄운 채 끝나지 않는다)
  if (dbUp && !existsSync(PG_READY)) writeOrFail(PG_READY, new Date().toISOString());
  if (!pgReady()) {
    rmSync(PG_READY, { force: true });
    if (existsSync(PGDATA)) {
      say('처음 실행이 중간에 끊겨 반쯤 만든 데이터베이스를 지우고 다시 만든다');
      rmSync(PGDATA, { recursive: true, force: true });
    }
    say('처음이라 데이터베이스를 만든다 — 1~2분 걸린다');
    const pw = join(DATA, 'pw.tmp');
    writeOrFail(pw, settings.WF_PG_EMBEDDED_PASSWORD);
    try {
      runOrFail(exe('initdb'), ['-D', PGDATA, '-U', 'workfluence', `--pwfile=${pw}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], '데이터베이스를 만들지 못했다', {
        hint: PATH_HINT,
      });
    } finally {
      rmSync(pw, { force: true });
    }
    writeOrFail(PG_READY, new Date().toISOString());
  }
  if (dbUp) {
    // 주인 없이 남은 데이터베이스다(떠 있는 실행은 위의 PID 파일에서 걸렀다) — 이어 쓰고, 멈출 때 같이 멈춘다
    say('앞서 남은 데이터베이스를 이어 쓴다');
    state.ownDb = true;
  } else {
    state.ownDb = true;
    runOrFail(exe('pg_ctl'), ['start', '-D', PGDATA, '-o', `-p ${dbPort}`, '-l', join(DATA, 'postgres.log'), '-w', '-t', '120'], `데이터베이스를 띄우지 못했다 — ${join(DATA, 'postgres.log')}를 본다`, {
      hint: PATH_HINT,
    });
  }
  try {
    await ensureDatabase(settings);
  } catch (e) {
    const auth = /password authentication failed/i.test(errText(e))
      ? ' — data\\settings.env의 비밀번호가 이 데이터베이스와 맞지 않는다. settings.env를 고쳤으면 되돌리고, 처음부터 다시 하려면 멈춘 뒤 data 폴더를 통째로 지운다'
      : '';
    fail(`데이터베이스(workfluence)를 만들지 못했다 — ${errText(e)}${auth}`);
  }
  runOrFail(process.execPath, [join(API, 'dist', 'db', 'migrate.js')], '표를 만들지 못했다', { cwd: API, env });
  // 첫 관리자 — 시드는 멱등이고 비밀번호를 덮어쓰지 않는다(apps/api/src/db/seed.ts 머리말). 새로 만들었을 때만 비밀번호를 보인다
  const seed = runOrFail(process.execPath, [join(API, 'dist', 'db', 'seed.js')], '첫 관리자를 만들지 못했다', { cwd: API, env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  const seedOut = String(seed.stdout ?? '').trim();
  if (seedOut) console.log(seedOut);
  const created = /root 계정 생성/.test(seedOut);

  const app = spawn(process.execPath, ['--enable-source-maps', join(API, 'dist', 'main.js')], { cwd: API, env, stdio: 'inherit' });
  state.app = app;
  app.on('exit', (code) => {
    if (!state.stopping) {
      say(`앱이 끝났다 (종료 코드 ${code}) — 위의 줄을 본다`);
      shutdown(code || 1);
    }
  });

  const url = `http://127.0.0.1:${appPort}`;
  for (let i = 0; i < 120 && !state.stopping; i++) {
    // 이 실행의 앱이 살아 있을 때의 답만 받는다 — 같은 자리를 다른 프로그램이 잡았으면 그쪽이 답한다
    if (await healthy(url, app)) {
      say(`위키가 떴다 — 브라우저에서 ${url}`);
      if (created) say(`처음 로그인: 아이디 ${settings.WF_ROOT_USERNAME} / 비밀번호 ${settings.WF_ROOT_PASSWORD}  (첫 로그인에서 바꾸게 된다)`);
      say('멈추려면 이 창에서 Ctrl+C (창을 그냥 닫았으면 멈추기.cmd)');
      if (openBrowser) openBrowserAt(url);
      return;
    }
    await sleep(1000);
  }
  if (!state.stopping) fail('앱이 2분 안에 답하지 않았다 — 위의 줄을 본다');
}

/** 멈추기 — 이 묶음의 여는 스크립트·앱으로 확인된 것만 끝낸다. PID 파일의 번호가 남의 것이면 파일만 지운다 */
function stop() {
  let failed = false;
  let did = false;
  const pid = lockPid();
  const procs = bundleProcesses();
  if (procs === null) {
    if (existsSync(PIDFILE)) {
      say('떠 있는 프로세스를 확인하지 못해 끝내지 않는다(PowerShell을 쓸 수 없다) — 위키 창이 열려 있으면 그 창을 닫는다');
      rmSync(PIDFILE, { force: true });
    }
  } else {
    if (pid !== null && !procs.some((p) => p.pid === pid && p.kind === 'start')) say(`data\\launcher.pid의 번호(${pid})는 이 묶음의 실행이 아니다 — 파일만 지운다`);
    // 여는 스크립트부터(그 아래의 앱도 함께 끝난다), 그다음 홀로 남은 앱
    for (const kind of ['start', 'app'])
      for (const p of procs.filter((q) => q.kind === kind)) {
        if (taskkill(p.pid)) did = true;
      }
    rmSync(PIDFILE, { force: true });
  }
  const db = stopDatabase();
  if (db === 'failed') {
    failed = true;
    console.error(`[체험] 데이터베이스를 멈추지 못했다 — ${join(DATA, 'postgres.log')}를 본다. 작업 관리자에서 이 폴더의 postgres.exe를 끝낼 수 있다`);
  }
  if (db === 'stopped') did = true;
  if (failed) process.exit(1);
  say(did ? '멈췄다' : '떠 있는 것이 없다');
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'start') await start(!rest.includes('--no-browser'));
  else if (command === 'stop') stop();
  else fail('쓰는 법: 시작.cmd 또는 멈추기.cmd');
} catch (e) {
  fail(`예상하지 못한 오류로 멈춘다 — ${errText(e)}`);
}
