// F-009 체험 묶음을 여는 스크립트 — 묶음 안의 app\launcher.mjs로 돈다(scripts/win-bundle.ts가 넣는다). Node 기본 모듈만 쓴다.
//   start [--no-browser] : 처음이면 설정·데이터베이스·첫 관리자를 만든다. 데이터베이스와 앱을 띄우고 브라우저를 연다. Ctrl+C·창 닫기로 둘 다 멈춘다.
//                          이미 떠 있으면 브라우저만 열고 끝낸다
//   stop                 : 남은 앱과 데이터베이스를 멈춘다(창을 그냥 닫았을 때). 확인하지 못한 것은 건드리지 않고, 그렇다고 말하고 1로 끝난다
// 데이터베이스는 pg_ctl로 띄운다 — 관리자 권한 창에서도 뜬다(scripts/dev-db.ts와 같은 까닭). 데이터는 묶음 안의 data\에 남는다.
// 설정 키의 이름(WF_*)을 여기서 쓴다 — 키를 더하거나 바꾸면 이 파일도 같이 고친다(CLAUDE.md 5절).
/* global process, console, setTimeout, fetch, AbortSignal, Buffer -- Node가 주는 것들(이 파일은 묶음 안에서 Node로만 돈다) */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(APP);
const API = join(APP, 'api');
const BIN = join(ROOT, 'pgsql', 'bin');
const DATA = join(ROOT, 'data');
const PGDATA = join(DATA, 'pgdata');
const SETTINGS = join(DATA, 'settings.env');
const PIDFILE = join(DATA, 'launcher.pid');
// initdb가 끝까지 갔다는 표시 — PG_VERSION은 initdb가 처음에 써서 반쯤 만든 데이터베이스와 가리지 못한다. 표시는 pgdata 밖에 있어 pgdata와 따로 놀 수
// 있다(표시만 지워지거나 pgdata만 옮겨 온다) — 그래서 표시가 없을 때는 pgdata 안의 사실로 다시 본다(`pgState`)
const PG_READY = join(DATA, 'pgdata.ready');
// 앞선 판이 쓰던 표시(첫 관리자를 만들었다). 지금은 "그 데이터베이스는 다 만들어졌다"의 증거로만 읽는다
const LEGACY_SEEDED = join(DATA, 'seeded');
// PostgreSQL이 사용자 객체에 주는 첫 번호(FirstNormalObjectId) — initdb가 만드는 데이터베이스(template1·template0·postgres)는 이보다 작다
const FIRST_NORMAL_OID = 16384;
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
// PowerShell이 끝까지 돌았다는 마지막 줄
const PS_END = 'WF-TRIAL-END';
// 이 PC의 다른 계정 모두를 가리키는 SID — Everyone · Authenticated Users · Users
const OTHERS_SIDS = ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'];
// 쓰기로 치는 권한 — WriteData · AppendData · DeleteSubdirectoriesAndFiles · Delete · ChangePermissions · TakeOwnership · GENERIC_ALL · GENERIC_WRITE
const WRITE_RIGHTS = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

const exe = (name) => join(BIN, `${name}.exe`);
const say = (s) => console.log(`[체험] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e instanceof Error ? e.message : String(e));

// 이 실행이 맡은 것 — 멈출 때 이것만 치운다. 다른 실행이 띄운 데이터베이스를 멈추지 않는다.
// tmp: 끝날 때 지울 파일(비밀번호를 담은 임시 파일 — 실패로 끝나도 지운다). hidden: 확인하지 못한 Node가 있다(권한이 다른 창·PowerShell을 쓸 수 없다)
const state = { lock: false, ownDb: false, app: null, stopping: false, tmp: [], hidden: null };

function cleanup() {
  const app = state.app;
  if (app && app.exitCode === null && app.signalCode === null) app.kill();
  if (state.ownDb && stopDatabase() === 'failed') console.error(`[체험] 데이터베이스를 멈추지 못했다 — 멈추기.cmd를 누른다`);
  for (const f of state.tmp) rmSync(f, { force: true });
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
 * PowerShell 한 줄을 돌려 출력 줄을 돌려준다. 스크립트는 **표준 입력으로** 넘긴다(`-Command -`) — 명령줄에 base64로 인코딩한 스크립트를 싣는
 * 모양(`-EncodedCommand`)은 회사 보안 도구가 흔히 막거나 경보를 낸다. 마지막에 끝 표시(`PS_END`)를 찍어 끝까지 돌았는지 본다 — 막혔거나 도중에
 * 멈췄으면 null(호출하는 쪽이 "확인하지 못했다"로 다룬다). 스크립트와 출력은 ASCII만 쓴다(경로는 환경변수로 넘기고 base64로 돌려받는다)
 */
function powershell(line, env = {}) {
  const r = spawnSync(join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: `${line}; '${PS_END}'\r\n`,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 60_000,
  });
  if (r.error || typeof r.stdout !== 'string') return null;
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim());
  const end = lines.lastIndexOf(PS_END);
  return end < 0 ? null : lines.slice(0, end);
}

/**
 * 견줄 수 있는 모양의 경로 — 실제 경로(8.3 짧은 이름을 긴 이름으로, subst 드라이브·폴더 연결을 실제 자리로)를 소문자·`\`로. 읽지 못하면 글자 그대로를
 * 같은 모양으로 맞춘다
 */
function canonical(p) {
  let r = resolve(p);
  try {
    r = realpathSync.native(p);
  } catch {
    // 읽을 수 없는 자리다 — 글자 그대로 견준다
  }
  return r.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase();
}

/**
 * 이 묶음의 node.exe일 수 있는 다른 프로세스 — [{ pid, kind, mine }]. 알 수 없으면(PowerShell을 쓸 수 없다) null.
 * - mine: 'yes'(실행 파일이 지금 이 node.exe다 — 경로는 `canonical`로 맞춰 견준다) · 'unknown'(실행 파일 경로가 비었다 — 권한이 다른 창의 프로세스는
 *   보이지 않는다). 다른 폴더의 묶음, 이 PC의 다른 Node 프로그램('no')은 돌려주지 않는다
 * - kind: 'start'(여는 스크립트의 start) · 'app'(앱) · 'other' · 'unknown'(명령줄이 비었다 — 역시 권한이 다를 때)
 */
function bundleProcesses() {
  const out = powershell(
    [
      "$ErrorActionPreference = 'Stop'",
      '$c = [StringComparison]::OrdinalIgnoreCase',
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | ForEach-Object { " +
        '$cl = [string]$_.CommandLine; $p = [string]$_.ExecutablePath; ' +
        "$k = if (-not $cl) { 'unknown' } elseif ($cl.IndexOf('\\api\\dist\\main.js', $c) -ge 0) { 'app' } " +
        "elseif ($cl.IndexOf('\\app\\launcher.mjs', $c) -ge 0 -and $cl -match '\\sstart(\\s|$)') { 'start' } else { 'other' }; " +
        "$e = if ($p) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)) } else { '-' }; " +
        "'{0} {1} {2}' -f $_.ProcessId, $k, $e }",
    ].join('; '),
  );
  if (out === null) return null;
  const me = canonical(process.execPath);
  const procs = [];
  for (const line of out) {
    const m = /^(\d+) (start|app|other|unknown) (\S+)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    const mine = m[3] === '-' ? 'unknown' : canonical(Buffer.from(m[3], 'base64').toString('utf8')) === me ? 'yes' : 'no';
    if (mine !== 'no') procs.push({ pid: Number(m[1]), kind: m[2], mine });
  }
  return procs;
}

/** 확인하지 못한 것 — 이 묶음의 것인지, 무엇을 도는지 모르는 Node */
const unverified = (p) => p.mine === 'unknown' || p.kind === 'unknown';

const taskkill = (pid) => spawnSync(join(SYS32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;

/** 그 번호가 지금 node.exe인가(PowerShell 없이 — tasklist) */
function isNodePid(pid) {
  const t = spawnSync(join(SYS32, 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /"node\.exe"/i.test(t.stdout ?? '');
}

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
 * **판정할 수 없으면 모른다로 다룬다** — 그 번호의 Node를 볼 수 없으면(권한이 다른 창, PowerShell을 쓸 수 없다) 떠 있는 것으로 보고 파일을 지우지 않는다.
 * 돌려주는 값: null(잡았다) 또는 { pid, unsure } — pid는 떠 있는 실행의 번호('?'면 아직 번호가 없다), unsure는 확인하지 못한 까닭
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
      if (age < FRESH_LOCK_MS) return { pid: '?', unsure: null };
    } else {
      const procs = bundleProcesses();
      if (procs === null) {
        // 확인할 길이 없다 — 그 번호가 아직 node.exe면 떠 있는 것으로 본다(끝내지는 않는다)
        if (isNodePid(pid)) return { pid, unsure: 'PowerShell을 쓸 수 없어 확인하지 못했다' };
      } else {
        const p = procs.find((q) => q.pid === pid);
        if (p && p.mine === 'yes' && p.kind === 'start') return { pid, unsure: null };
        if (p && unverified(p)) return { pid, unsure: '권한이 다른 창(관리자 권한 등)의 Node라 이 창에서는 무엇인지 보이지 않는다' };
      }
    }
    say('지난 실행이 남긴 data\\launcher.pid를 치운다(그 번호는 이 묶음의 실행이 아니다)');
    rmSync(PIDFILE, { force: true });
  }
  return { pid: '?', unsure: null };
}

/** 앞서 끝나지 않고 남은 이 묶음의 앱(여는 스크립트는 죽고 앱만 남은 것)을 멈춘다 — 3000번을 쥐고 있다. 확인하지 못한 Node는 건드리지 않고 기억만 한다 */
function stopOrphanApps() {
  const procs = bundleProcesses();
  if (!procs) {
    state.hidden = 'PowerShell을 쓸 수 없어 이 묶음의 앱이 남았는지 확인하지 못했다 — 작업 관리자의 "세부 정보"에서 이 폴더의 node.exe를 끝낸 뒤 다시 누른다';
    return;
  }
  if (procs.some(unverified))
    state.hidden = '권한이 다른 창(관리자 권한 등)에서 띄운 Node가 있다 — 이 묶음을 그렇게 띄웠으면 그 창을 닫거나 멈추기.cmd를 같은 권한으로 누른다';
  for (const p of procs.filter((q) => q.mine === 'yes' && q.kind === 'app')) {
    say(`앞서 남은 이 묶음의 앱(PID ${p.pid})을 멈춘다`);
    if (!taskkill(p.pid)) say(`경고: 앞서 남은 앱(PID ${p.pid})을 멈추지 못했다`);
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
 * data\ 와 그 안의 settings.env(비밀 값)의 권한, 이 폴더의 쓰기 권한을 본다(모르면 null). 권한을 열어 둘 수 있는 것은 지금 사용자·SYSTEM·Administrators(`ok`)뿐이다.
 * - dataAcl: data\ 가 상속을 끊었고 권한 목록이 `ok`의 항목뿐이다. extra: data\ 에 **따로 준**(물려받지 않은) `ok` 밖의 SID — 좁히는 명령이 남기는 것이다
 * - fileAcl: settings.env의 권한 목록(물려받은 것까지)이 `ok`의 항목뿐이다. dataOwner·fileOwner: 주인이 `ok`다 — 주인은 권한 목록과 무관하게 권한을 다시 준다
 * - open: 이 폴더를 이 PC의 다른 계정(Everyone·Authenticated Users·Users)도 고칠 수 있다(C:\ 바로 아래에 만든 폴더가 그렇다). me: 지금 사용자의 SID
 */
function aclFacts() {
  const out = powershell(
    [
      "$ErrorActionPreference = 'Stop'",
      '$id = [Security.Principal.SecurityIdentifier]',
      '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      "$ok = @($me, 'S-1-5-18', 'S-1-5-32-544')",
      '$d = Get-Acl -LiteralPath $env:TRIAL_DATA',
      '$dr = @($d.GetAccessRules($true, $true, $id))',
      '$bad = @($dr | Where-Object { $_.IsInherited -or ($ok -notcontains $_.IdentityReference.Value) })',
      '$extra = @($dr | Where-Object { (-not $_.IsInherited) -and ($ok -notcontains $_.IdentityReference.Value) } | ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)',
      '$dAcl = [int]($d.AreAccessRulesProtected -and $dr.Count -gt 0 -and $bad.Count -eq 0)',
      '$dOwn = [int]($ok -contains $d.GetOwner($id).Value)',
      '$fAcl = 1',
      '$fOwn = 1',
      'if (Test-Path -LiteralPath $env:TRIAL_SETTINGS) { $f = Get-Acl -LiteralPath $env:TRIAL_SETTINGS; ' +
        '$fAcl = [int](@($f.GetAccessRules($true, $true, $id) | Where-Object { $ok -notcontains $_.IdentityReference.Value }).Count -eq 0); ' +
        '$fOwn = [int]($ok -contains $f.GetOwner($id).Value) }',
      `$others = @(${OTHERS_SIDS.map((x) => `'${x}'`).join(', ')})`,
      `$open = @((Get-Acl -LiteralPath $env:TRIAL_ROOT).GetAccessRules($true, $true, $id) | Where-Object { $_.AccessControlType -eq 'Allow' -and $others -contains $_.IdentityReference.Value -and (([int]$_.FileSystemRights) -band ${WRITE_RIGHTS}) })`,
      "$x = if ($extra.Count) { $extra -join ',' } else { '-' }",
      "'{0} {1} {2} {3} {4} {5} {6}' -f $dAcl, $dOwn, $fAcl, $fOwn, [int]($open.Count -gt 0), $me, $x",
    ].join('; '),
    { TRIAL_DATA: DATA, TRIAL_SETTINGS: SETTINGS, TRIAL_ROOT: ROOT },
  );
  const m = out && /^([01]) ([01]) ([01]) ([01]) ([01]) (S-1-[\d-]+) (\S+)$/.exec(out[out.length - 1] ?? '');
  if (!m) return null;
  const [dataAcl, dataOwner, fileAcl, fileOwner, open] = m.slice(1, 6).map((v) => v === '1');
  return { dataAcl, dataOwner, fileAcl, fileOwner, open, narrow: dataAcl && dataOwner && fileAcl && fileOwner, me: m[6], extra: m[7] === '-' ? [] : m[7].split(',') };
}

/**
 * data\ 에는 비밀 값(settings.env)과 데이터베이스가 든다 — **시작할 때마다** 보고 지금 사용자·SYSTEM·Administrators만 열 수 있게 한다(이미 그렇면 그대로):
 * data\ 의 상속을 끊고 셋에게만 주고, 다른 계정에 따로 준 항목을 지우고, settings.env에 따로 준 항목을 지우고(폴더에서 물려받는 것만 남긴다), 주인이 다른
 * 계정이면(다른 계정의 폴더를 옮겨 왔다) 안의 것까지 지금 사용자로 바꾼다. **고친 뒤 다시 보고**, 아직 넓으면 무엇이 넓은지 말한다(체험은 계속된다).
 * 탐색기로 폴더를 복사하면 data\ 가 새 자리의 상속을 받는다 — 처음 한 번만 좁히면 복사한 뒤에는 넓은 채로 남는다(T-088).
 * 이 폴더(실행 파일) 자체는 좁히지 않는다 — 다른 계정이 고칠 수 있는 자리면 그렇다고 말한다(읽어보기·windows시연가이드 10.2절)
 */
function restrictData() {
  const facts = aclFacts();
  if (facts?.open)
    say(
      '경고: 이 폴더는 이 PC의 다른 계정도 고칠 수 있다(C:\\ 바로 아래에 만든 폴더 등) — 다른 사람이 이 PC에 로그인하면 실행 파일(node\\node.exe·pgsql\\bin 등)을 ' +
        '바꾸거나 더해 둘 수 있다. 혼자 쓰는 PC에서만 쓰거나, 내 사용자 폴더(C:\\Users\\<이름>) 아래로 옮긴다(이름이 영문일 때 — 읽어보기.txt)',
    );
  if (facts?.narrow) return;
  if (!facts) say('data 폴더의 권한을 PowerShell로 읽지 못했다 — 다시 좁힌다');
  const who = facts ? null : spawnSync(join(SYS32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = facts?.me ?? /S-1-[\d-]+/.exec(who?.stdout ?? '')?.[0];
  const icacls = (args) => spawnSync(join(SYS32, 'icacls.exe'), args, { stdio: 'ignore', windowsHide: true }).status === 0;
  let ok = Boolean(sid);
  if (sid && (!facts || !facts.dataAcl)) {
    ok = icacls([DATA, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']) && ok;
    // 위 명령은 이름을 준 셋만 고친다 — 다른 계정에 따로 준 항목은 남는다
    if (facts?.extra.length) ok = icacls([DATA, '/remove', ...facts.extra.map((x) => `*${x}`)]) && ok;
  }
  if (sid && facts && (!facts.dataOwner || !facts.fileOwner)) ok = icacls([DATA, '/setowner', `*${sid}`, '/T', '/C', '/Q']) && ok;
  if (sid && facts && !facts.fileAcl) ok = icacls([SETTINGS, '/reset']) && ok;
  const after = facts ? aclFacts() : null;
  if (after?.narrow || (!after && ok)) {
    say(`data 폴더의 권한을 지금 사용자·관리자만 열 수 있게 좁혔다${after ? '' : '(PowerShell로 다시 확인하지는 못했다)'}`);
    return;
  }
  const wide = after
    ? [!after.dataAcl && 'data 폴더의 권한 목록', !after.dataOwner && 'data 폴더의 주인', !after.fileAcl && 'settings.env의 권한 목록', !after.fileOwner && 'settings.env의 주인'].filter(Boolean)
    : [];
  say(
    `경고: data 폴더의 권한을 좁히지 못했다${wide.length ? `(아직 넓은 것: ${wide.join('·')})` : ''} — 이 PC를 다른 사람과 같이 쓰면 data\\settings.env의 비밀 값을 ` +
      '읽을 수 있다. data 폴더와 settings.env의 속성 → 보안에서 지금 사용자·SYSTEM·Administrators 밖의 항목을 지우고, 주인을 지금 사용자로 바꾼다',
  );
}

/** 처음 실행 — `.env.example`을 바탕으로 비밀 값을 무작위로 만든다. 비밀은 이 파일에만 있다 */
function createSettings() {
  const s = parseEnv(readFileSync(join(APP, 'env.example'), 'utf8'));
  Object.assign(s, {
    // production이면 쿠키에 Secure가 붙어 http로 로그인하지 못한다(windows시연가이드 4.2절)
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
    WF_API_JWT_SECRET: randomBytes(32).toString('hex'),
  });
  Object.assign(s, placeKeys(s));
  const lines = ['# workfluence 체험 설정 — 처음 실행에서 만들었다. 비밀 값이 들어 있다(이 폴더 밖으로 보내지 않는다)'];
  lines.push('# 자리(경로)와 데이터베이스 주소는 시작할 때마다 이 폴더의 지금 위치로 다시 쓴다. 자리 번호는 WF_PORT(앱)·WF_PG_EMBEDDED_PORT(데이터베이스)만 고친다');
  for (const [k, v] of Object.entries(s)) lines.push(envLine(k, v));
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

/**
 * 이 판의 앱이 모르는 설정 키를 뺀다 — 앱의 설정 검사는 모르는 WF_ 키가 있으면 뜨지 않는다(CLAUDE.md 5절). 옛 묶음의 data\ 를 새 묶음으로 옮겨 오면
 * 없어졌거나 이름이 바뀐 키가 남는다. 그 줄은 **파일에서 지우지 않고** 앱에 넘기지 않는다(사람이 쓴 파일이다 — 옛 묶음으로 돌아가도 그대로 쓰인다).
 * 아는 키는 묶음의 env.example(`.env.example` — 앱의 설정 검사와 키가 같다, 시험이 강제한다)이 정한다
 */
function knownSettings(settings) {
  const known = new Set(Object.keys(parseEnv(readFileSync(join(APP, 'env.example'), 'utf8'))));
  const unknown = Object.keys(settings).filter((k) => k.startsWith('WF_') && !known.has(k));
  if (unknown.length)
    say(`경고: data\\settings.env의 ${unknown.join(', ')}는 이 판의 앱이 모르는 설정이다(옛 묶음의 설정일 수 있다) — 앱에 넘기지 않는다. 메모장으로 그 줄을 지우면 이 경고가 없어진다`);
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !unknown.includes(k)));
}

/**
 * 앱·표 만들기·첫 관리자에 넘길 환경 — 이 컴퓨터에 남은 WF_ 변수는 뺀다(앱의 설정 검사는 모르는 WF_ 키가 있으면 뜨지 않는다).
 * `WF_ROOT_PASSWORD`는 첫 관리자(시드)에만 넘긴다(`seed`) — 떠 있는 앱에는 넘기지 않는다(P13 FR-1422, 운영의 compose와 같다)
 */
function childEnv(settings, { seed = false } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('WF_')) env[k] = v;
  const out = { ...env, ...settings };
  if (!seed) delete out.WF_ROOT_PASSWORD;
  return out;
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
  // 확인하지 못한 Node가 있으면(`stopOrphanApps`) 그것이 이 묶음의 앱일 수 있다 — 자리를 바꾸기 전에 그것부터 본다
  const maybeOurs = state.hidden && what === '앱' ? `. 다만 ${state.hidden}` : '';
  fail(`${what} 자리 ${port}번을 다른 프로그램이 쓰고 있다(다른 폴더의 체험 묶음·"가" 길의 pnpm start 등) — 그 프로그램을 끄거나, ${change}${maybeOurs}`);
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
 * 한 번이라도 서버로 떴거나 앱의 데이터가 든 데이터베이스인가 — pgdata 안의 사실만 본다.
 * - `postmaster.opts`: 서버가 뜰 때마다 쓰고 멈춰도 남는다. initdb는 서버를 띄우지 않아 쓰지 않는다
 * - `base\<번호>`가 `FIRST_NORMAL_OID` 이상: initdb 뒤에 만든 데이터베이스(앱의 workfluence)가 있다
 */
function usedCluster() {
  if (existsSync(join(PGDATA, 'postmaster.opts'))) return true;
  try {
    return readdirSync(join(PGDATA, 'base')).some((n) => /^\d+$/.test(n) && Number(n) >= FIRST_NORMAL_OID);
  } catch {
    return false;
  }
}

/**
 * 데이터베이스 폴더의 상태 — 'none'(없다·비었다) · 'ready'(다 만들었다) · 'half'(만들다 끊겼다).
 * 끝났다는 표시(`PG_READY`)는 pgdata 밖에 있어 pgdata와 따로 놀 수 있다 — `data\pgdata`만 지우면 표시가 남고(그때는 'none'), 표시만 지우거나
 * pgdata만 옮겨 오면 표시가 없다. **표시가 없다는 것만으로 쓰던 데이터베이스를 반쯤 만든 것으로 보지 않는다** — pgdata 안의 사실(`usedCluster`)로 다시 본다
 */
function pgState() {
  if (!existsSync(PGDATA)) return 'none';
  let names = [];
  try {
    names = readdirSync(PGDATA);
  } catch {
    return 'half';
  }
  if (!names.length) return 'none';
  if (!names.includes('PG_VERSION')) return 'half';
  if (existsSync(PG_READY)) return 'ready';
  if (usedCluster() || existsSync(LEGACY_SEEDED)) {
    writeOrFail(PG_READY, new Date().toISOString());
    return 'ready';
  }
  return 'half';
}

/**
 * 끝까지 만들지 못한 데이터베이스 폴더를 **지우지 않고 옆으로 옮긴다**(`data\pgdata.broken-<시각>`) — 판정이 틀렸어도 데이터가 남는다. 옮기지 못하면
 * (그 폴더의 파일을 누가 쥐고 있다) 까닭을 말하고 멈춘다
 */
function setAside() {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  const aside = join(DATA, `pgdata.broken-${stamp}`);
  try {
    renameSync(PGDATA, aside);
  } catch (e) {
    fail(
      `끝까지 만들지 못한 데이터베이스(data\\pgdata)를 옆으로 옮기지 못했다(${e.code ?? errText(e)}) — 멈추기.cmd를 누르고 다시 누른다. ` +
        '그래도 이 말이 나오면 작업 관리자에서 이 폴더의 postgres.exe를 끝낸다',
    );
  }
  say(`data\\pgdata는 끝까지 만들어지지 않았다(처음 실행이 끊겼다) — 지우지 않고 data\\${basename(aside)}로 옮겨 두고 새로 만든다. 쓸 것이 없으면 그 폴더는 지워도 된다`);
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

const appPortOfSettings = () => {
  try {
    return Number(parseEnv(readFileSync(SETTINGS, 'utf8')).WF_PORT) || DEFAULT_APP_PORT;
  } catch {
    // 설정이 아직 없다 — 먼저 연 실행이 처음 설정을 만드는 중이다
    return DEFAULT_APP_PORT;
  }
};

async function alreadyRunning({ pid, unsure }, openBrowser) {
  const url = `http://127.0.0.1:${appPortOfSettings()}`;
  const up = await healthy(url, null);
  say(`이미 떠 있다${pid === '?' ? '' : ` (PID ${pid})`} — ${up ? `브라우저에서 ${url}` : '아직 뜨는 중이다. 먼저 연 창을 본다'}`);
  if (unsure)
    say(
      `다만 그 번호가 이 묶음의 실행인지 ${unsure} — 떠 있지 않은데 이 말이 되풀이되면 모든 명령 창을 닫고 data\\launcher.pid를 지운 뒤 다시 누른다`,
    );
  say('멈추려면 먼저 연 창에서 Ctrl+C, 창을 닫았으면 멈추기.cmd');
  if (up && openBrowser) openBrowserAt(url);
  if (!up && process.env.TRIAL_NO_PAUSE !== '1') await sleep(5000);
  // 확인하지 못했고 답도 없으면 1 — 창이 닫히지 않아 위의 말을 읽는다
  process.exit(unsure && !up ? 1 : 0);
}

/** 첫 관리자(시드)가 실패한 까닭 한 줄 — 시드의 오류 문장에서 스택을 뺀다 */
function seedReason(stderr) {
  const line = String(stderr ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim() && !/^\s+at /.test(l));
  return (line ?? '').replace(/^\[seed\] 실패:\s*/, '').replace(/^Error:\s*/, '').trim();
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
  restrictData();
  warnLongPath();
  stopOrphanApps();
  ensureLinks();
  const pw = join(DATA, 'pw.tmp');
  state.tmp.push(pw);
  rmSync(pw, { force: true });

  if (!existsSync(SETTINGS)) {
    if (pgState() === 'ready')
      fail(
        'data\\settings.env가 없는데 데이터베이스(data\\pgdata)는 있다 — 그 데이터베이스의 비밀번호가 settings.env에만 있었다. ' +
          'settings.env를 되돌리거나, 처음부터 다시 하려면 data 폴더를 통째로 지우고 다시 누른다',
      );
    createSettings();
  }
  let settings = parseEnv(readFileSync(SETTINGS, 'utf8'));
  const dbPort = portOf(settings, 'WF_PG_EMBEDDED_PORT');
  const appPort = portOf(settings, 'WF_PORT');
  settings = knownSettings(syncSettings(readFileSync(SETTINGS, 'utf8'), settings));
  const env = childEnv(settings);

  await requireFreePort(appPort, '0.0.0.0', 'WF_PORT', '앱');
  const dbUp = dbRunning();
  if (!dbUp) await requireFreePort(dbPort, '127.0.0.1', 'WF_PG_EMBEDDED_PORT', '데이터베이스');

  // 떠 있는 데이터베이스는 다 만들어진 것이다(initdb는 서버를 띄운 채 끝나지 않는다)
  if (dbUp && !existsSync(PG_READY)) writeOrFail(PG_READY, new Date().toISOString());
  const pg = pgState();
  // 이 실행이 데이터베이스를 새로 만든다 — 그러면 첫 관리자가 꼭 있어야 한다(아래 시드)
  const fresh = pg !== 'ready';
  if (fresh) {
    rmSync(PG_READY, { force: true });
    if (pg === 'half') setAside();
    say('데이터베이스를 만든다 — 1~2분 걸린다');
    writeOrFail(pw, settings.WF_PG_EMBEDDED_PASSWORD);
    runOrFail(exe('initdb'), ['-D', PGDATA, '-U', 'workfluence', `--pwfile=${pw}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], '데이터베이스를 만들지 못했다', {
      hint: PATH_HINT,
    });
    rmSync(pw, { force: true });
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
  // 첫 관리자 — 시작할 때마다 돈다: 시드는 멱등이고 비밀번호를 덮어쓰지 않으며(apps/api/src/db/seed.ts 머리말) 빠진 것을 채운다. 표시 파일에 기대지 않아
  // 데이터베이스를 다시 만든 뒤에도 root가 생긴다. **실패는 멈춘다 — "그 아이디가 root가 아니다" 하나만 경고로 내리고 위키를 띄운다**: 그 계정이 있고
  // root가 아니면 root가 따로 있다(마지막 root는 내릴 수 없고, 가입보다 시드가 먼저 root를 만든다) — 막으면 쓰던 위키를 다시 열 길이 없다. 그 밖의 실패
  // (그 아이디의 계정이 없는데 WF_ROOT_PASSWORD가 비었다 등)는 root가 있는지 모른다 — 띄우면 아무도 로그인하지 못하는 위키일 수 있다. "이번에 데이터베이스를
  // 만들었나"로 가르지 않는다 — 만든 뒤 시드가 실패하면 다음 시작에서는 이미 만든 데이터베이스다. 새로 만들었을 때만 비밀번호를 보인다
  const seedUser = settings.WF_ROOT_USERNAME || 'root';
  const seed = spawnSync(process.execPath, [join(API, 'dist', 'db', 'seed.js')], { cwd: API, env: childEnv(settings, { seed: true }), encoding: 'utf8', windowsHide: true });
  const seedOut = String(seed.stdout ?? '').trim();
  if (seedOut) console.log(seedOut);
  let created = false;
  if (seed.error || seed.status !== 0) {
    const reason = seed.error?.message ?? seedReason(seed.stderr);
    if (!/root가 아니다/.test(reason)) {
      // 아는 까닭이 아니면 시드가 쓴 것을 그대로 보인다(스택 포함)
      if (seed.stderr && !/WF_ROOT_PASSWORD가 없다/.test(reason)) process.stderr.write(seed.stderr);
      const hint = /WF_ROOT_PASSWORD가 없다/.test(reason)
        ? `아이디 ${seedUser}인 계정이 이 데이터베이스에 없어 새로 만들어야 한다 — data\\settings.env의 WF_ROOT_PASSWORD에 첫 비밀번호를 적어 저장하고 ` +
          '다시 누른다(첫 로그인에서 바꾸게 된다). WF_ROOT_USERNAME을 바꿨으면 그 아이디가 맞는지도 본다'
        : 'data\\settings.env의 WF_ROOT_USERNAME·WF_ROOT_PASSWORD를 본다';
      fail(`첫 관리자를 ${fresh ? '만들지' : '확인하지'} 못했다 — ${reason ? reason.split(' — ')[0] : `종료 코드 ${seed.status}`}. ${hint}`);
    }
    const hint =
      `이 묶음의 설정은 data\\settings.env다. 이 경고를 없애려면 그 파일의 WF_ROOT_USERNAME을 지금 root인 계정의 아이디로 바꾼다 — 없는 아이디로 바꾸면 ` +
      'settings.env에 남은 첫 비밀번호(WF_ROOT_PASSWORD)로 root가 새로 생긴다';
    say(`경고: 첫 관리자(${seedUser})를 확인하지 못했다 — 위키는 그대로 띄운다. 까닭: ${reason.split(' — ')[0]}`);
    say(`다른 root 계정으로 로그인해 쓰면 된다. ${hint}`);
  } else created = /root 계정 생성/.test(seedOut);

  const app = spawn(process.execPath, ['--enable-source-maps', join(API, 'dist', 'main.js')], { cwd: API, env, stdio: 'inherit' });
  state.app = app;
  // 띄우지도 못했으면(실행 파일을 못 찾는다 등) 'exit'이 오지 않는다 — 까닭을 말하고 이번에 띄운 데이터베이스를 멈춘다
  app.on('error', (e) => fail(`앱을 띄우지 못했다 — ${errText(e)}`));
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
      if (created) say(`처음 로그인: 아이디 ${seedUser} / 비밀번호 ${settings.WF_ROOT_PASSWORD}  (첫 로그인에서 바꾸게 된다)`);
      say('멈추려면 이 창에서 Ctrl+C (창을 그냥 닫았으면 멈추기.cmd)');
      if (openBrowser) openBrowserAt(url);
      return;
    }
    await sleep(1000);
  }
  if (!state.stopping) fail('앱이 2분 안에 답하지 않았다 — 위의 줄을 본다');
}

/**
 * 멈추기 — 이 묶음의 여는 스크립트·앱으로 확인된 것만 끝낸다. PID 파일의 번호가 남의 것이면 파일만 지운다.
 * **확인하지 못한 것은 건드리지 않고 그렇다고 말한다**(1로 끝난다) — 데이터베이스만 멈추면 앱이 데이터베이스 없이 자리를 쥔 채 남는다. 그래서 데이터베이스는
 * 이 묶음의 Node를 **모두 확인하고 모두 끝냈을 때만** 멈춘다: 권한이 다른 창의 Node(경로·명령줄이 보이지 않는다)가 하나라도 있거나, 끝내지 못한 것이 아직
 * 떠 있거나, PowerShell을 쓸 수 없어 PID 파일의 번호가 아직 떠 있는 Node거나 앱 자리가 답하면 그대로 둔다(PID 파일이 없거나 낡아도 여는 스크립트만 끝나 앱이
 * 남았을 수 있다 — 3차 재검토). 앱 자리(`WF_PORT`)에 위키가 아직 답하는지는 어느 갈래에서든 본다
 */
async function stop() {
  let failed = false;
  let did = false;
  let keep = false;
  // 남은 Node가 이 묶음의 것일 수 있다(권한이 다른 창·PowerShell을 쓸 수 없다·끝내지 못했다) — 앱 자리가 답하면 그것이다
  let doubt = false;
  const pid = lockPid();
  const procs = bundleProcesses();
  const sameRights = '그 창에서 Ctrl+C로 멈추거나, 이 멈추기.cmd를 같은 권한으로(마우스 오른쪽 → 관리자 권한으로 실행) 누른다';
  const url = `http://127.0.0.1:${appPortOfSettings()}`;
  if (procs === null) {
    failed = true;
    doubt = true;
    say('떠 있는 프로세스를 확인하지 못했다(PowerShell을 쓸 수 없다) — 여는 스크립트·앱은 끝내지 않는다. 위키 창이 열려 있으면 그 창에서 Ctrl+C');
    if (pid !== null && isNodePid(pid)) {
      keep = true;
      say(`data\\launcher.pid의 번호(${pid})가 아직 떠 있는 Node다 — 이 묶음의 실행일 수 있어 데이터베이스도 그대로 둔다`);
    } else {
      rmSync(PIDFILE, { force: true });
      if (await healthy(url, null)) {
        keep = true;
        say(`${url}에서 위키가 답한다 — 이 묶음의 앱일 수 있어 데이터베이스도 그대로 둔다`);
      }
    }
  } else {
    const lock = pid === null ? undefined : procs.find((p) => p.pid === pid);
    const hidden = procs.filter(unverified);
    if (lock && unverified(lock)) {
      keep = true;
      say(`data\\launcher.pid의 번호(${pid})는 권한이 다른 창(관리자 권한 등)의 Node라 이 창에서는 무엇인지 보이지 않는다 — 끝내지 않고 데이터베이스도 그대로 둔다. ${sameRights}`);
    } else {
      // 여는 스크립트부터(그 아래의 앱도 함께 끝난다), 그다음 홀로 남은 앱. 끝내지 못했는데 아직 떠 있으면 실패다 — 데이터베이스를 두고 PID 파일도 둔다
      const alive = [];
      for (const kind of ['start', 'app'])
        for (const p of procs.filter((q) => q.mine === 'yes' && q.kind === kind)) {
          if (taskkill(p.pid)) did = true;
          else if (isNodePid(p.pid)) {
            alive.push(p.pid);
            console.error(`[체험] PID ${p.pid}(${kind === 'start' ? '여는 스크립트' : '앱'})를 끝내지 못했다 — 작업 관리자의 "세부 정보"에서 끝낸다`);
          }
        }
      const ours = lock && lock.mine === 'yes' && lock.kind === 'start';
      if (!(ours && alive.includes(lock.pid))) {
        if (pid !== null && !ours) say(`data\\launcher.pid의 번호(${pid})는 이 묶음의 실행이 아니다 — 파일만 지운다`);
        rmSync(PIDFILE, { force: true });
      }
      if (alive.length) {
        keep = true;
        doubt = true;
        say('끝내지 못한 것이 있어 데이터베이스는 그대로 둔다 — 그것을 끝낸 뒤 멈추기.cmd를 다시 누른다');
      }
      if (hidden.length) {
        keep = true;
        say(
          `권한이 다른 창(관리자 권한 등)의 Node(PID ${hidden.map((p) => p.pid).join(', ')})가 있어 이 창에서는 이 묶음의 것인지 보이지 않는다 — ` +
            `데이터베이스는 그대로 둔다. ${sameRights}(이 묶음의 것이 아니면 관리자 권한의 멈추기가 그렇게 알아보고 데이터베이스를 멈춘다)`,
        );
      }
    }
    if (hidden.length) doubt = true;
    if (keep) failed = true;
  }
  let dbFailed = false;
  if (!keep) {
    const db = stopDatabase();
    if (db === 'failed') {
      failed = true;
      dbFailed = true;
      console.error(`[체험] 데이터베이스를 멈추지 못했다 — ${join(DATA, 'postgres.log')}를 본다. 작업 관리자에서 이 폴더의 postgres.exe를 끝낼 수 있다`);
    }
    if (db === 'stopped') did = true;
  }
  // 앱 자리 — 끝낸 프로세스가 자리를 놓기까지 잠깐 기다린다
  let answering = await healthy(url, null);
  for (let i = 0; answering && did && i < 10; i++) {
    await sleep(500);
    answering = await healthy(url, null);
  }
  if (answering && doubt) {
    failed = true;
    console.error(`[체험] ${url}에서 아직 위키가 답한다 — 이 묶음의 앱일 수 있다. 그 창을 닫거나 작업 관리자의 "세부 정보"에서 이 폴더의 node.exe를 끝낸다`);
  } else if (answering) say(`참고: ${url}에서 위키가 답한다 — 이 폴더의 것은 아니다(이 폴더의 Node는 모두 확인했다 — 다른 폴더의 묶음이나 가 길의 pnpm start 등)`);
  else if (procs === null && !keep && !dbFailed) {
    // 확인하지 못했지만 앱 자리가 닫혀 있고 데이터베이스도 멈췄다 — 멈춘 것으로 본다
    say(`앱 자리(${url})는 닫혀 있고 데이터베이스는 ${did ? '멈췄다' : '떠 있지 않았다'}`);
    failed = false;
  }
  if (failed) process.exit(1);
  say(did ? '멈췄다' : '떠 있는 것이 없다');
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'start') await start(!rest.includes('--no-browser'));
  else if (command === 'stop') await stop();
  else fail('쓰는 법: 시작.cmd 또는 멈추기.cmd');
} catch (e) {
  fail(`예상하지 못한 오류로 멈춘다 — ${errText(e)}`);
}
