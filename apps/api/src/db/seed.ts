/**
 * 시드 (CLAUDE.md 6절: 멱등 — 두 번 실행해도 결과가 같다).
 *
 * Phase 1은 **최초 root 계정** 하나를 넣는다. 없으면 만들고, 있으면 빠진 것만 채운다.
 *
 * 멱등 규칙: "있으면 건너뜀"으로 끝내지 않고 **빠진 필드를 채우는 것**까지 포함한다.
 * 스키마가 늘어난 뒤 기존 행이 비어 있는 상태를 시드가 고쳐야 한다.
 *
 * **비밀번호는 덮어쓰지 않는다.** 사람이 바꿔 둔 것을 시드가 되돌리면 그 자체가 사고다.
 * 계정이 이미 있으면 WF_ROOT_PASSWORD는 무시된다 — **새로 만들 때만 필요하다**(P13 FR-1422: 기동 중인 앱에는 넘기지 않는 값이라 선택이다).
 *
 * **정지된 계정은 되살리지 않는다** (P13 C.5). 버전 갱신 때 시드를 다시 돌려도, 일부러 정지해 둔 최초 계정이 조용히 활성으로 돌아오지
 * 않게 한다. 승인 대기만 활성으로 고친다.
 *
 * **root가 아닌 계정을 root로 올리지 않는다** (병합 전 보안 검토 M1). 예전에는 같은 아이디의 계정이 있으면 역할과 상관없이 root로 올리고
 * 승인 대기면 활성으로 바꿨다 — 비밀번호는 그 사람의 것 그대로. 앱이 떠 있는데 root가 아직 없을 때(5-1절을 건너뛰었을 때) 누가 가입
 * 화면에서 그 아이디로 가입해 두면, 운영자가 안내대로 시드를 치는 순간 그 사람이 자기 비밀번호로 root가 됐다. 일부러 강등해 둔 계정도
 * 되돌렸다. 이제는 까닭을 말하고 멈춘다 — 다른 아이디(`WF_ROOT_USERNAME`)로 다시 친다.
 *
 * **불러오기만 해서는 돌지 않는다** — 명령으로 부를 때만(`require.main`). 예전에는 불러오는 순간 `.env`의 DB에 대해 돌았다
 */
import type { AppEnv } from '@workfluence/shared';
import * as argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { databaseUrl, loadEnv } from '../config/config.module';
import { SpacesService } from '../spaces/spaces.service';
import * as schema from './schema';

/** 최초 root를 만들거나 빠진 것을 채운다. 무엇을 했는지 한 줄로 돌려준다. 시험은 시험 DB를 넘긴다 */
export async function seedRoot(env: AppEnv = loadEnv(), url: string = databaseUrl(env)): Promise<string> {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    const username = env.WF_ROOT_USERNAME;
    const existing = await db.query.users.findFirst({ where: eq(schema.users.username, username) });

    /** 개인 스페이스 보장. SpacesService는 DB만 있으면 되므로 Nest 없이 직접 쓴다 */
    const spaces = new SpacesService(db as never);

    if (!existing) {
      if (!env.WF_ROOT_PASSWORD) {
        throw new Error('WF_ROOT_PASSWORD가 없다 — 최초 root 계정을 만들려면 필요하다(개발은 .env, 운영은 compose의 tools 서비스)');
      }
      const [created] = await db.insert(schema.users).values({
        username,
        displayName: '시스템 관리자',
        email: null,
        passwordHash: await argon2.hash(env.WF_ROOT_PASSWORD, { type: argon2.argon2id }),
        role: 'root',
        status: 'active',
        // 첫 로그인에서 반드시 바꾸게 한다 — .env에 적힌 값이 계속 유효하면 그것이 곧 유출 경로다
        mustChangePassword: true,
        approvedAt: sql`now()`,
      }).returning();
      await spaces.ensurePersonalSpace(created.id, created.displayName, db as never);
      return `root 계정 생성: ${username} (첫 로그인에서 비밀번호 변경 강제)`;
    }

    // **남의 계정을 root로 올리지 않는다** (위 머리말). 개인 스페이스도 만들지 않는다 — 아무것도 바꾸지 않고 멈춘다
    if (existing.role !== 'root') {
      throw new Error(
        `아이디 ${username}인 계정이 이미 있는데 root가 아니다(역할 ${existing.role}, 상태 ${existing.status}) — 누가 그 아이디로 가입했거나 ` +
          '일부러 강등한 계정이다. 시드는 그 계정을 root로 올리지 않는다: 그 계정을 확인하고, .env의 WF_ROOT_USERNAME을 다른 아이디로 바꿔 다시 친다',
      );
    }

    // 이미 있는 계정도 개인 스페이스가 없으면 만든다 — 멱등 규칙은 "빠진 것을 채우는 것"까지다
    await spaces.ensurePersonalSpace(existing.id, existing.displayName, db as never);

    // 있으면 빠진 것만 채운다. 비밀번호는 건드리지 않는다
    const fixes: Record<string, unknown> = {};
    if (existing.status === 'pending') fixes.status = 'active';
    if (!existing.approvedAt) fixes.approvedAt = sql`now()`;
    const fixed = Object.keys(fixes);
    if (fixed.length) await db.update(schema.users).set({ ...fixes, updatedAt: sql`now()` }).where(eq(schema.users.id, existing.id));

    if (existing.status === 'suspended') {
      return `root 계정이 정지돼 있다: ${username} — 되살리지 않는다(관리 화면의 정지 해제로)${fixed.length ? ` · 보정 — ${fixed.join(', ')}` : ''}`;
    }
    return fixed.length ? `root 계정 보정: ${username} — ${fixed.join(', ')}` : `root 계정 이미 정상: ${username}`;
  } finally {
    await pool.end();
  }
}

/** 명령으로 부를 때만 돈다 — `pnpm db:seed`, 컨테이너에서는 `tools`로 `node dist/db/seed.js` (설치및실행가이드 5-1절) */
if (require.main === module) {
  seedRoot()
    .then((line) => console.log(`[seed] ${line}`))
    .catch((e: unknown) => {
      console.error('[seed] 실패:', e);
      process.exit(1);
    });
}
