import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { databaseUrl, loadEnv } from '../config/config.module';
import { runMigrations } from '../db/migrate';
import * as schema from '../db/schema';

/**
 * 통합 테스트용 실제 PostgreSQL (CLAUDE.md 3절 B등급 — **DB는 대역을 쓰지 않는다**).
 *
 * `WF_ENV=test`로 읽으므로 `databaseUrl()`이 테스트 DB를 고른다. 테스트 URL이 없으면
 * 개발 DB로 조용히 붙지 않고 실패한다 (config.module.ts).
 */
export type TestDb = NodePgDatabase<typeof schema>;

/**
 * 테스트 풀 크기. **테스트가 이 값을 읽어 동시 요청 수를 정한다** (T-026 회귀 테스트).
 *
 * 예전에는 테스트가 "8개를 동시에 던진다"를 직접 적어 두고 주석에 "풀은 4"라고 썼다.
 * 누가 이 값을 16으로 올리면 **8은 전부 통과하고 결함이 되살아난 채 테스트가 초록이 된다** —
 * 두 숫자를 묶어 두지 않으면 조용히 무장해제된다 (코드 리뷰 5).
 */
export const TEST_POOL_MAX = 4;

let pool: Pool | undefined;
let migrated = false;

export async function openTestDb(): Promise<{ db: TestDb; pool: Pool }> {
  const env = loadEnv();
  pool ??= new Pool({ connectionString: databaseUrl({ ...env, WF_ENV: 'test' }), max: TEST_POOL_MAX });
  if (!migrated) {
    await runMigrations(pool);
    migrated = true;
  }
  return { db: drizzle(pool, { schema }), pool };
}

export async function closeTestDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  migrated = false;
}

/**
 * 테이블 비우기.
 *
 * **DELETE가 아니라 TRUNCATE를 쓴다.** `audit_events`에 UPDATE/DELETE 차단 트리거가 걸려 있어
 * DELETE는 거부된다. 행 단위 BEFORE 트리거는 TRUNCATE에 반응하지 않으므로 이쪽으로 비운다.
 */
export async function resetTables(db: TestDb): Promise<void> {
  // `users`를 지우면 그것을 참조하는 것들이 CASCADE로 함께 지워진다. 그런데 **`labels`는
  // users로 이어지는 FK가 없어** 그 사슬에 걸리지 않는다 — 따로 적지 않으면 테스트 사이에
  // 라벨이 쌓이고, "다른 파일을 함께 돌릴 때만 깨지는" 실패가 된다 (P4에서 실제로 겪었다).
  // 표를 늘릴 때는 **그것이 users에 닿는지**를 보고, 안 닿으면 여기 적는다
  await db.execute(sql`TRUNCATE TABLE audit_events, settings, sessions, labels, users RESTART IDENTITY CASCADE`);

  // 비워졌는지 **확인한다.** 정리가 조용히 실패하면 앞 테스트가 남긴 계정 때문에 엉뚱한
  // 테스트가 깨지고, 원인을 찾기 어려운 간헐적 실패로 나타난다. 실제로 한 번 겪었다 —
  // 단독 실행은 통과하는데 `pnpm check`에서만 세 건이 깨졌고 재현되지 않았다.
  // 여기서 막으면 다음에는 "정리가 안 됐다"로 바로 드러난다.
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM users`);
  const n = (r.rows[0] as { n: number }).n;
  if (n !== 0) throw new Error(`테스트 정리 실패: users에 ${n}행이 남았다. 앞 테스트의 상태가 샌다`);
}
