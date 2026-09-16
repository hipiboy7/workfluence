/**
 * pnpm dev:db — 개발용 임베디드 PostgreSQL을 .local/pgdata(D 드라이브)에서 띄운다 (CLAUDE.md 8.1절).
 * 최초 실행 시 initdb + 데이터베이스 생성. Ctrl+C로 종료. 데이터는 유지된다.
 * 주의: PostgreSQL은 관리자 권한(elevated) 셸에서 기동을 거부한다.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from '../packages/shared/src/env';

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

async function main(): Promise<void> {
  const env = parseEnv({ ...loadDotenv(resolve(root, '.env')), ...process.env });
  const databaseDir = resolve(root, env.WF_PG_EMBEDDED_DIR);
  const firstRun = !existsSync(resolve(databaseDir, 'PG_VERSION'));

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'workfluence',
    password: env.WF_PG_EMBEDDED_PASSWORD,
    port: env.WF_PG_EMBEDDED_PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  if (firstRun) {
    console.log(`[dev-db] initdb → ${databaseDir}`);
    await pg.initialise();
  }
  await pg.start();
  console.log(`[dev-db] PostgreSQL 기동: 127.0.0.1:${env.WF_PG_EMBEDDED_PORT} (데이터 ${databaseDir})`);

  if (firstRun) {
    await pg.createDatabase('workfluence');
    await pg.createDatabase('workfluence_test');
    console.log('[dev-db] 데이터베이스 생성: workfluence, workfluence_test');
  }
  console.log('[dev-db] READY. Ctrl+C로 종료.');

  const stop = async () => {
    console.log('\n[dev-db] 종료 중...');
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('[dev-db] 실패:', e);
  process.exit(1);
});
