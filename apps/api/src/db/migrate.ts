/**
 * 마이그레이션 적용 (CLAUDE.md 6절). drizzle/ 폴더의 SQL을 순서대로, 적용된 것은 건너뛴다(멱등).
 * - pnpm db:migrate — 배포 절차의 명시적 단계
 * - WF_DB_AUTO_MIGRATE=true — 개발에서만 기동 시 자동 (env.ts가 운영에서는 거부)
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { applyAppRole } from './app-role';

export const MIGRATIONS_FOLDER = resolve(__dirname, '..', '..', 'drizzle');

export async function runMigrations(pool: Pool): Promise<string> {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const r = await pool.query<{ n: string }>('select count(*)::text as n from drizzle.__drizzle_migrations');
  return `${r.rows[0].n}개 마이그레이션 적용 상태`;
}

if (require.main === module) {
  // CLI 실행: 루트 .env를 읽는다 (config.module과 같은 로더·같은 접속 문자열 선택)
  (async () => {
    const { loadEnv, databaseUrl } = await import('../config/config.module');
    const env = loadEnv();
    const url = databaseUrl(env);
    const pool = new Pool({ connectionString: url });
    try {
      console.log(`[migrate] ${MIGRATIONS_FOLDER} → ${url.replace(/\/\/.*@/, '//***@')}`);
      console.log(`[migrate] ${await runMigrations(pool)}`);
      // **앱 계정과 권한** (P13 D.3, 보류 12) — 운영(compose의 tools)에서만 값이 있다. 개발·시험은 비어 있어 하지 않는다
      if (env.WF_DB_APP_ROLE && env.WF_DB_APP_PASSWORD) console.log(`[migrate] ${await applyAppRole(pool, env.WF_DB_APP_ROLE, env.WF_DB_APP_PASSWORD)}`);
    } finally {
      await pool.end();
    }
  })().catch((e) => {
    console.error('[migrate] 실패:', e);
    process.exit(1);
  });
}
