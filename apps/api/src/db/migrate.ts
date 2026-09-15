/**
 * 마이그레이션 적용 (CLAUDE.md 6절). drizzle/ 폴더의 SQL을 순서대로, 적용된 것은 건너뛴다(멱등).
 * - pnpm db:migrate — 배포 절차의 명시적 단계
 * - WF_DB_AUTO_MIGRATE=true — 개발에서만 기동 시 자동 (env.ts가 운영에서는 거부)
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { Pool } from 'pg';

export const MIGRATIONS_FOLDER = resolve(__dirname, '..', '..', 'drizzle');

export async function runMigrations(pool: Pool): Promise<string> {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const r = await pool.query<{ n: string }>('select count(*)::text as n from drizzle.__drizzle_migrations');
  return `${r.rows[0].n}개 마이그레이션 적용 상태`;
}

if (require.main === module) {
  // CLI 실행: 루트 .env를 읽는다 (config.module과 같은 로더)
  (async () => {
    const { loadEnv } = await import('../config/config.module');
    const env = loadEnv();
    const pool = new Pool({ connectionString: env.WF_DATABASE_URL });
    try {
      console.log(`[migrate] ${MIGRATIONS_FOLDER} → ${env.WF_DATABASE_URL.replace(/\/\/.*@/, '//***@')}`);
      console.log(`[migrate] ${await runMigrations(pool)}`);
    } finally {
      await pool.end();
    }
  })().catch((e) => {
    console.error('[migrate] 실패:', e);
    process.exit(1);
  });
}
