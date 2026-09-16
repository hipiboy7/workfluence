/**
 * pnpm dev:db — 개발용 임베디드 PostgreSQL을 .local/pgdata(D 드라이브)에서 띄운다 (CLAUDE.md 8.1절).
 * 최초 실행 시 initdb + 데이터베이스 생성. Ctrl+C로 종료. 데이터는 유지된다.
 *
 * 주의
 * - PostgreSQL은 관리자 권한(elevated) 셸에서 기동을 거부한다.
 * - 이전 프로세스를 Ctrl+C가 아닌 방식으로 죽이면 `postmaster.pid`가 남아 다음 기동이 실패한다.
 *   그 경우 남은 프로세스가 실제로 없을 때만 잠금 파일을 치운다 (살아 있으면 건드리지 않는다).
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const root = resolve(__dirname, '..');

function loadDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** 남은 잠금 파일 정리. 그 PID가 살아 있으면 손대지 않고 그대로 알린다. */
function clearStaleLock(databaseDir: string): void {
  const lock = resolve(databaseDir, 'postmaster.pid');
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8').split(/\r?\n/)[0]);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0); // 신호 0 = 존재 확인만
      throw new Error(`이미 PostgreSQL이 떠 있다 (PID ${pid}). 그 프로세스를 먼저 종료한다.`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('이미 PostgreSQL')) throw e;
      // ESRCH: 그 PID는 없다 → 남은 잠금 파일이다
    }
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

async function main(): Promise<void> {
  const env = { ...loadDotenv(resolve(root, '.env')), ...process.env } as Record<string, string>;
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
  await pg.start();
  console.log(`[dev-db] PostgreSQL 기동: 127.0.0.1:${port} (데이터 ${databaseDir})`);

  await ensureDatabases(port, password, ['workfluence', 'workfluence_test']);
  console.log('[dev-db] READY. Ctrl+C로 종료.');

  const stop = async () => {
    console.log('\n[dev-db] 종료 중...');
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e: unknown) => {
  console.error('[dev-db] 실패:', e instanceof Error ? e.message : e);
  process.exit(1);
});
