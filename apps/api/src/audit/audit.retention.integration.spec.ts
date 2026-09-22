import { sql } from 'drizzle-orm';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';

/**
 * 감사로그 보존 정리의 **예외가 정확히 좁은지** 본다 (FR-540, `0005_audit_retention`).
 *
 * append-only를 깨는 예외를 여는 일이므로, 여는 것보다 **안 열리는 것**을 더 많이 확인한다.
 */

let db: TestDb;

const insert = (action: string, ageDays: number) =>
  db.execute(sql`INSERT INTO audit_events (action, target_type, created_at) VALUES (${action}, 'system', now() - (${ageDays} || ' days')::interval)`);
const countRows = async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n);

/**
 * **결과로 단언한다** — 거부됐고 행이 그대로인지.
 *
 * 드리즐이 오류를 감싸는 방식이 호출 경로마다 달라(`cause`가 붙기도 하고 안 붙기도 한다)
 * 메시지 매칭은 실행 순서에 따라 흔들렸다. 우리가 지키려는 것은 문구가 아니라 **"안 지워진다"**다.
 * 트리거가 낸 문구 자체는 아래 한 테스트가 따로 확인한다.
 */
async function expectBlocked(p: Promise<unknown>, survivors: number): Promise<void> {
  const err = await p.then(() => null).catch((e: unknown) => e);
  expect(err).not.toBeNull();
  expect(await countRows()).toBe(survivors);
}

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('append-only는 그대로다', () => {
  it('그냥 지우려 하면 막는다. **트리거가 낸 문구까지 확인한다**', async () => {
    await insert('space.create', 400);
    const err = await db
      .execute(sql`DELETE FROM audit_events`)
      .then(() => null)
      .catch((e: unknown) => e);
    // 겉 메시지는 "Failed query"이고 원문은 `cause`에 있다
    expect(inspect(err, { depth: 6 })).toMatch(/append-only/);
    expect(await countRows()).toBe(1);
  });

  it('같은 것을 결과로도 확인한다', async () => {
    await insert('space.create', 400);
    await expectBlocked(db.execute(sql`DELETE FROM audit_events`), 1);
  });

  it('**고치는 것은 어떤 경우에도 막는다** — 예외를 열어도', async () => {
    await insert('space.create', 400);
    await expectBlocked(db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('wf.audit_purge', 'on', true), set_config('wf.audit_purge_before', (now())::text, true)`);
        await tx.execute(sql`UPDATE audit_events SET action = 'x'`);
      }), 1);
  });

  it('표시만 하고 시각을 안 주면 막는다 — 둘 다 있어야 열린다', async () => {
    await insert('space.create', 400);
    await expectBlocked(db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('wf.audit_purge', 'on', true)`);
        await tx.execute(sql`DELETE FROM audit_events`);
      }), 1);
  });
});

describe('보존 기간이 지난 것만 지워진다', () => {
  it('**기준보다 최근 것은 예외를 열어도 안 지워진다**', async () => {
    await insert('old', 400);
    await insert('recent', 1);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('wf.audit_purge', 'on', true), set_config('wf.audit_purge_before', (now() - interval '365 days')::text, true)`);
      await tx.execute(sql`DELETE FROM audit_events WHERE created_at < (now() - interval '365 days')`);
    });

    const rows = await db.execute<{ action: string }>(sql`SELECT action FROM audit_events`);
    expect(rows.rows.map((r) => r.action)).toEqual(['recent']);
  });

  it('기준을 넓게 잡아도 **트리거가 다시 막는다** — 질의와 예외 조건이 어긋나면 통과하지 않는다', async () => {
    await insert('recent', 1);
    await expectBlocked(db.transaction(async (tx) => {
        // 예외는 365일 이전만 열어 두고, 질의는 전부 지우려 한다
        await tx.execute(sql`SELECT set_config('wf.audit_purge', 'on', true), set_config('wf.audit_purge_before', (now() - interval '365 days')::text, true)`);
        await tx.execute(sql`DELETE FROM audit_events`);
      }), 1);
    expect(await countRows()).toBe(1);
  });

  it('표시는 트랜잭션 안에서만 산다 — 다음 트랜잭션에서는 다시 막힌다', async () => {
    await insert('old', 400);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('wf.audit_purge', 'on', true), set_config('wf.audit_purge_before', (now())::text, true)`);
    });
    await expectBlocked(db.execute(sql`DELETE FROM audit_events`), 1);
  });
});
