/**
 * 시드 (CLAUDE.md 6절: 멱등 — 두 번 실행해도 결과가 같다).
 *
 * Phase 0은 넣을 데이터가 없다. 틀만 둔다. Phase 1이 root 계정과 기본 카테고리를 넣는다.
 *
 * 멱등 규칙: "있으면 건너뜀"으로 끝내지 않고 **빠진 필드를 채우는 것**까지 포함한다.
 * 스키마가 늘어난 뒤 기존 행이 비어 있는 상태를 시드가 고쳐야 한다 (프로토타입에서 실제로 겪었다).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { databaseUrl, loadEnv } from '../config/config.module';
import * as schema from './schema';

async function main(): Promise<void> {
  // 접속 문자열 선택은 databaseUrl 한 곳에서 (test 환경에서 개발 DB를 건드리지 않는다)
  const pool = new Pool({ connectionString: databaseUrl(loadEnv()) });
  const db = drizzle(pool, { schema });
  try {
    // Phase 0: 넣을 데이터 없음. 연결이 정상인지만 확인한다.
    await db.select().from(schema.settings).limit(1);
    console.log('[seed] Phase 0 — 시드할 데이터가 없다 (계정·카테고리는 Phase 1)');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[seed] 실패:', e);
  process.exit(1);
});
