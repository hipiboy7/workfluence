import { sql } from 'drizzle-orm';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DELEGABLE_ACTIONS, ROLES, SPACE_KINDS, SPACE_MEMBER_ROLES, SPACE_STATUSES, USER_STATUSES } from '@workfluence/shared';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';

/**
 * `0006_constraints`가 실제로 거는지 본다 (FR-627).
 *
 * **코드를 안 거치고 들어오는 값**을 막으려고 넣은 제약이므로, 테스트도 서비스가 아니라
 * SQL로 직접 넣어 본다. 서비스를 거치면 zod가 먼저 막아 제약이 있는지 알 수 없다.
 */

let db: TestDb;

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

const rejected = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null).catch((x: unknown) => x);
  expect(e, '거부돼야 한다').not.toBeNull();
  return inspect(e, { depth: 6 });
};

/** `users_login_method_chk`(기존 제약)가 로그인 수단 하나를 요구하므로 해시 자리를 채운다 */
async function makeUser(role = 'member', status = 'active'): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (username, display_name, role, status, password_hash)
        VALUES ('u1', '사용자', ${role}, ${status}, '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA')`,
  );
}

describe('값 집합 제약 (0006)', () => {
  it('users.role은 상수 목록 밖의 값을 거부한다', async () => {
    expect(await rejected(makeUser('superuser'))).toMatch(/users_role_chk/);
  });

  it('users.status도 마찬가지다', async () => {
    expect(await rejected(makeUser('member', 'deleted'))).toMatch(/users_status_chk/);
  });

  it('**대소문자가 다른 값도 거부한다** — 조용히 살아 있으면 판정이 엉뚱해진다', async () => {
    expect(await rejected(makeUser('Member'))).toMatch(/users_role_chk/);
  });

  it('상수 목록에 있는 값은 전부 들어간다 — 제약이 코드보다 좁으면 기동이 깨진다', async () => {
    for (const role of ROLES) {
      for (const status of USER_STATUSES) {
        await resetTables(db);
        await makeUser(role, status);
      }
    }
    expect(ROLES.length * USER_STATUSES.length).toBe(6);
  });

  it('spaces.kind·status와 space_members.role도 같은 방식으로 걸린다', async () => {
    await makeUser('root');
    const uid = (await db.execute<{ id: string }>(sql`SELECT id FROM users LIMIT 1`)).rows[0].id;
    const mk = (kind: string, status: string) =>
      db.execute(sql`INSERT INTO spaces (key, name, kind, status, created_by) VALUES ('K1', '스페이스', ${kind}, ${status}, ${uid})`);

    expect(await rejected(mk('shared', 'active'))).toMatch(/spaces_kind_chk/);
    expect(await rejected(mk('team', 'archived'))).toMatch(/spaces_status_chk/);

    await mk('team', 'active');
    const sid = (await db.execute<{ id: string }>(sql`SELECT id FROM spaces LIMIT 1`)).rows[0].id;
    expect(
      await rejected(db.execute(sql`INSERT INTO space_members (space_id, user_id, role) VALUES (${sid}, ${uid}, 'admin')`)),
    ).toMatch(/space_members_role_chk/);

    // 정본 목록은 전부 통과해야 한다
    expect(SPACE_KINDS.length + SPACE_STATUSES.length + SPACE_MEMBER_ROLES.length).toBe(7);
  });
});

describe('page_versions는 고쳐 쓰지 않는다 (0006)', () => {
  async function onePage(): Promise<{ pageId: string }> {
    await makeUser('root');
    const uid = (await db.execute<{ id: string }>(sql`SELECT id FROM users LIMIT 1`)).rows[0].id;
    await db.execute(sql`INSERT INTO spaces (key, name, kind, status, created_by) VALUES ('K2', '스페이스', 'team', 'active', ${uid})`);
    const sid = (await db.execute<{ id: string }>(sql`SELECT id FROM spaces LIMIT 1`)).rows[0].id;
    await db.execute(
      sql`INSERT INTO pages (space_id, title, current_version_no, created_by, updated_by) VALUES (${sid}, '문서', 1, ${uid}, ${uid})`,
    );
    const pid = (await db.execute<{ id: string }>(sql`SELECT id FROM pages LIMIT 1`)).rows[0].id;
    await db.execute(
      sql`INSERT INTO page_versions (page_id, version_no, title, content_json, created_by)
          VALUES (${pid}, 1, '문서', '{"type":"doc","content":[]}'::jsonb, ${uid})`,
    );
    return { pageId: pid };
  }

  it('UPDATE는 막는다 — 저장된 버전의 내용이 나중에 달라지면 이력이 아니다', async () => {
    await onePage();
    const msg = await rejected(db.execute(sql`UPDATE page_versions SET title = '바꿔치기'`));
    expect(msg).toMatch(/고쳐 쓰지 않는다/);
    const rows = await db.execute<{ title: string }>(sql`SELECT title FROM page_versions`);
    expect(rows.rows[0].title).toBe('문서');
  });

  it('**DELETE는 막지 않는다** — `pnpm trash:purge`가 실제로 하는 순서대로 지워 본다', async () => {
    const { pageId } = await onePage();
    // FK가 CASCADE가 아니므로 정리 명령은 버전을 **먼저** 지운다 (scripts/trash-purge.ts).
    // 여기서 DELETE를 막았다면 보존 기간이 지난 데이터를 영원히 못 지운다
    await db.execute(sql`DELETE FROM page_versions WHERE page_id = ${pageId}`);
    await db.execute(sql`DELETE FROM pages WHERE id = ${pageId}`);
    const left = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM page_versions`);
    expect(left.rows[0].n).toBe(0);
  });
});

describe('위임할 수 있는 행위 — 코드의 목록과 DB의 CHECK (P11 코드 리뷰 5)', () => {
  it('**`0010_ops`의 CHECK가 `DELEGABLE_ACTIONS`와 같은 목록이다** — 행위를 더하고 CHECK를 잊으면 root의 위임이 날것의 500이 된다', async () => {
    // 마이그레이션은 손으로 쓴 SQL이라 코드의 목록을 읽을 수 없다(보류 17). 둘이 같은지는 여기서만 본다
    const r = await db.execute<{ def: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'users_grants_known_chk'`,
    );
    expect(r.rows).toHaveLength(1);
    const inCheck = [...r.rows[0].def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual([...DELEGABLE_ACTIONS].sort());
  });
});
