/**
 * pnpm dev:db — 개발용 임베디드 PostgreSQL을 .local/pgdata에서 띄운다 (CLAUDE.md 8.1절).
 * 최초 실행 시 initdb + 데이터베이스 생성. Ctrl+C로 종료. 데이터는 유지된다.
 *
 * 주의
 * - PostgreSQL 서버는 관리자 권한으로 **직접** 띄우면 기동을 거부한다 (Linux root · Windows 관리자 권한 창).
 *   Windows는 그래서 서버를 `pg_ctl`로 띄운다 — 아래 `startOnWindows`. Linux는 root 셸에서 여전히 거부된다.
 * - 이전 프로세스를 Ctrl+C가 아닌 방식으로 죽이면 `postmaster.pid`가 남아 다음 기동이 실패한다.
 *   그 경우 남은 프로세스가 실제로 없을 때만 잠금 파일을 치운다 (살아 있으면 건드리지 않는다).
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { parseDotenv } from '../packages/shared/src/env';

const root = resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

/** Windows 종료 상태 0xC0000135 — 실행 파일에 필요한 DLL이 없다. 이때 프로세스는 **아무 출력 없이** 끝난다 */
const WINDOWS_DLL_NOT_FOUND = 0xc0000135;
/** Windows에서 서버가 살아 있는지 보는 주기 (아래 `main`) */
const WINDOWS_WATCH_MS = 5_000;


/** `.env`를 읽는다. 파싱은 shared의 `parseDotenv` 한 곳에서 한다 (CLAUDE.md 1.3절) */
function readDotenv(path: string): Record<string, string> {
  return existsSync(path) ? parseDotenv(readFileSync(path, 'utf8')) : {};
}

/**
 * 그 PID에 PostgreSQL 서버가 떠 있나. 신호 0은 존재만 묻는다 — 답은 셋이다: 보냈다(있다, 내 것), `ESRCH`(없다), `EPERM`(**있다, 다른 계정의 것** —
 * 보낼 권한만 없다). EPERM을 "없다"로 읽으면 다른 계정이 띄운 서버의 잠금 파일을 지운다(T-079). 거꾸로 재부팅 뒤 남은 잠금 파일의 번호를
 * **다른 계정의 상관없는 프로세스**가 받았으면 EPERM만으로는 영영 치우지 못한다(병합 전 코드 리뷰) — Linux는 `/proc/<pid>/cmdline`(누구나 읽는다)으로
 * 그 프로세스가 **이 데이터 디렉토리의** postgres인지 본다(`-D`). 내 계정의 프로세스가 번호를 받았을 때도, 공유 서버의 다른 postgres가 받았을 때도 같다
 * (좁은 재점검 N4) — 잠금 파일은 그 디렉토리의 서버만 쓴다. 읽을 수 없는 곳(Windows)은 떠 있다고 본다 — 틀리면 지우는 쪽이 데이터를 망가뜨린다
 */
function postgresAlive(pid: number, databaseDir: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  let args: string[];
  try {
    args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return true;
  }
  const dirs = new Set([databaseDir, realpathSync(databaseDir)]);
  const at = args.indexOf('-D');
  return /(^|\/)postgres$/.test(args[0] ?? '') && at >= 0 && dirs.has(resolve(args[at + 1] ?? ''));
}

/** 남은 잠금 파일 정리. 그 PID가 살아 있으면(다른 계정의 프로세스라도) 손대지 않고 그대로 알린다. */
function clearStaleLock(databaseDir: string): void {
  const lock = resolve(databaseDir, 'postmaster.pid');
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8').split(/\r?\n/)[0]);
  if (Number.isInteger(pid) && pid > 0 && postgresAlive(pid, databaseDir)) {
    throw new Error(`이미 PostgreSQL이 떠 있다 (PID ${pid}). 그 프로세스를 먼저 종료한다 — 다른 계정의 것이면 그 계정에서.`);
  }
  console.log('[dev-db] 남은 postmaster.pid를 정리한다 (해당 프로세스 없음)');
  rmSync(lock, { force: true });
}

/** 없는 데이터베이스만 만든다. "처음 실행이면 만든다"로 끝내면 중간에 죽었을 때 영영 건너뛴다. */
async function ensureDatabases(port: number, password: string, names: string[]): Promise<void> {
  const client = new Client({ host: '127.0.0.1', port, user: 'workfluence', password, database: 'postgres' });
  await client.connect();
  try {
    for (const name of names) {
      const found = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (found.rowCount === 0) {
        await client.query(`create database "${name}"`);
        console.log(`[dev-db] 데이터베이스 ${name}: 생성`);
      } else {
        console.log(`[dev-db] 데이터베이스 ${name}: 있음`);
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * Windows는 서버를 `pg_ctl`로 띄우고 끈다 (`docs/guide/shortcut/windows시연가이드.md` 6절).
 *
 * `embedded-postgres`는 `postgres.exe`를 직접 띄우는데, PostgreSQL은 관리자 그룹이 살아 있는 권한으로 직접 뜨기를 거부한다
 * ("Execution of PostgreSQL by a user with administrative permissions is not permitted"). **클라우드 VM의 내장
 * Administrator 계정은 모든 창이 그 권한이다**(UAC 기본값). GitHub의 Windows 러너도 그렇다. `pg_ctl`은 관리자 그룹을 뺀
 * 제한된 토큰으로 `postgres.exe`를 띄우므로 어느 창에서든 뜬다. `initdb`는 스스로 같은 일을 하므로 초기화는 그대로 둔다.
 *
 * 바이너리 패키지는 루트의 직접 의존성이 아니라 `embedded-postgres`의 선택 의존성이다 — 그 옆에서 찾는다.
 * `stop`은 **동기로 끈다** — 같은 신호를 받은 `embedded-postgres`의 종료 훅이 프로세스를 먼저 끝내기 전에.
 */
async function startOnWindows(databaseDir: string, port: number): Promise<{ pid: number; logFile: string; stop: () => void }> {
  const fromEmbedded = createRequire(createRequire(__filename).resolve('embedded-postgres'));
  const entry = fromEmbedded.resolve('@embedded-postgres/windows-x64');
  const { pg_ctl: pgCtl } = (await import(pathToFileURL(entry).href)) as { pg_ctl: string };
  const logFile = resolve(root, '.local', 'logs', 'dev-db-postgres.log');
  mkdirSync(dirname(logFile), { recursive: true });
  // -w: 접속을 받을 때까지 기다린다 · -l: 서버 로그는 파일로 간다(이 창에는 이 스크립트의 줄만 나온다)
  const started = spawnSync(pgCtl, ['start', '-D', databaseDir, '-o', `-p ${port}`, '-l', logFile, '-w', '-t', '120'], { stdio: 'inherit' });
  if (started.error) throw started.error;
  if (started.status !== 0) throw new Error(`pg_ctl start가 실패했다 (종료 코드 ${started.status}). 서버 로그: ${logFile}`);
  console.log(`[dev-db] 서버 로그: ${logFile}`);
  const pid = Number(readFileSync(resolve(databaseDir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]);
  return {
    pid,
    logFile,
    stop: () => {
      spawnSync(pgCtl, ['stop', '-D', databaseDir, '-m', 'fast', '-w'], { stdio: 'inherit' });
    },
  };
}

async function main(): Promise<void> {
  const env = { ...readDotenv(resolve(root, '.env')), ...process.env } as Record<string, string>;
  const databaseDir = resolve(root, env.WF_PG_EMBEDDED_DIR || '.local/pgdata');
  const port = Number(env.WF_PG_EMBEDDED_PORT || 5433);
  const password = env.WF_PG_EMBEDDED_PASSWORD || 'workfluence';
  const firstRun = !existsSync(resolve(databaseDir, 'PG_VERSION'));

  if (!firstRun) clearStaleLock(databaseDir);

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'workfluence',
    password,
    port,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  if (firstRun) {
    console.log(`[dev-db] initdb → ${databaseDir}`);
    await pg.initialise();
  }
  const onWindows = isWindows ? await startOnWindows(databaseDir, port) : undefined;
  if (!onWindows) await pg.start();
  console.log(`[dev-db] PostgreSQL 기동: 127.0.0.1:${port} (데이터 ${databaseDir})`);

  await ensureDatabases(port, password, ['workfluence', 'workfluence_test']);
  console.log('[dev-db] READY. Ctrl+C로 종료.');

  const stop = async () => {
    console.log('\n[dev-db] 종료 중...');
    if (onWindows) onWindows.stop();
    else await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (onWindows) {
    // 창을 닫으면 SIGHUP이 오고 조금 뒤 강제로 끝난다 — 그 사이에 서버를 끈다. 안 끄면 서버가 남아 다음 기동이 막힌다 (T-009).
    // Ctrl+Break는 SIGBREAK다
    process.on('SIGHUP', stop);
    process.on('SIGBREAK', stop);
    // **pg_ctl이 띄운 서버는 이 프로세스의 자식이 아니다.** 붙잡을 것이 없으면 Node가 READY 직후 끝나 창이 닫힌 것처럼 보이고
    // Ctrl+C로 끌 수도 없다(Linux는 embedded-postgres가 자식 프로세스로 붙잡는다). 서버가 살아 있는지 보면서 이 창을 붙잡아 둔다
    setInterval(() => {
      try {
        process.kill(onWindows.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return;
        console.error(`[dev-db] PostgreSQL 서버가 멈췄다 (PID ${onWindows.pid}). 서버 로그: ${onWindows.logFile}`);
        process.exit(1);
      }
    }, WINDOWS_WATCH_MS);
  }
}

main().catch((e: unknown) => {
  // embedded-postgres는 서버가 뜨지 못하면 까닭 없이(`undefined`로) 실패를 알린다 — 까닭은 바로 위의 PostgreSQL 로그 줄에 있다(T-079)
  const message = e instanceof Error ? e.message : (e ?? '까닭을 받지 못했다 — 바로 위의 PostgreSQL 로그 줄(FATAL)을 본다');
  console.error('[dev-db] 실패:', message);
  // DLL이 없으면 initdb·pg_ctl이 말없이 이 코드로 끝난다. PostgreSQL 실행 파일은 VC++ 런타임(VCRUNTIME140·MSVCP140)을 쓰는데 묶음에 없다
  // 종료 코드를 부호 없는 수(3221225781)로 찍는지 부호 있는 수(-1073741515)로 찍는지는 부른 쪽에 달려 있어 둘 다 본다
  const dllMissing = [WINDOWS_DLL_NOT_FOUND, WINDOWS_DLL_NOT_FOUND - 2 ** 32].some((code) => String(message).includes(String(code)));
  if (isWindows && dllMissing) {
    console.error('[dev-db] PostgreSQL 실행 파일이 쓰는 DLL이 없다 — Microsoft Visual C++ 재배포 가능 패키지(x64)를 깐다. docs/guide/shortcut/windows시연가이드.md 6절');
  }
  process.exit(1);
});
