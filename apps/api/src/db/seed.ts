/**
 * 시드 (CLAUDE.md 6절: 멱등 — 두 번 실행해도 결과가 같다).
 *
 * Phase 1은 **최초 root 계정** 하나를 넣는다. 없으면 만들고, 있으면 빠진 것만 채운다.
 *
 * 멱등 규칙: "있으면 건너뜀"으로 끝내지 않고 **빠진 필드를 채우는 것**까지 포함한다.
 * 스키마가 늘어난 뒤 기존 행이 비어 있는 상태를 시드가 고쳐야 한다.
 *
 * **비밀번호는 덮어쓰지 않는다.** 사람이 바꿔 둔 것을 시드가 되돌리면 그 자체가 사고다.
 * 계정이 이미 있으면 WF_ROOT_PASSWORD는 무시된다.
 */
import * as argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { databaseUrl, loadEnv } from '../config/config.module';
import * as schema from './schema';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: databaseUrl(env) });
  const db = drizzle(pool, { schema });
  try {
    const username = env.WF_ROOT_USERNAME;
    const existing = await db.query.users.findFirst({ where: eq(schema.users.username, username) });

    if (!existing) {
      await db.insert(schema.users).values({
        username,
        displayName: '시스템 관리자',
        email: null,
        passwordHash: await argon2.hash(env.WF_ROOT_PASSWORD, { type: argon2.argon2id }),
        role: 'root',
        status: 'active',
        // 첫 로그인에서 반드시 바꾸게 한다 — .env에 적힌 값이 계속 유효하면 그것이 곧 유출 경로다
        mustChangePassword: true,
        approvedAt: sql`now()`,
      });
      console.log(`[seed] root 계정 생성: ${username} (첫 로그인에서 비밀번호 변경 강제)`);
      return;
    }

    // 있으면 빠진 것만 채운다. 비밀번호는 건드리지 않는다
    const fixes: Record<string, unknown> = {};
    if (existing.role !== 'root') fixes.role = 'root';
    if (existing.status !== 'active') fixes.status = 'active';
    if (!existing.approvedAt) fixes.approvedAt = sql`now()`;

    if (Object.keys(fixes).length === 0) {
      console.log(`[seed] root 계정 이미 정상: ${username}`);
    } else {
      await db.update(schema.users).set({ ...fixes, updatedAt: sql`now()` }).where(eq(schema.users.id, existing.id));
      console.log(`[seed] root 계정 보정: ${username} — ${Object.keys(fixes).join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[seed] 실패:', e);
  process.exit(1);
});
