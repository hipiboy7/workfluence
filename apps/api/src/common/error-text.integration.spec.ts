import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, openTestDb, type TestDb } from '../test/db';
import { errorStack, errorText, isQueryError } from './error-text';

/**
 * B등급 — **실제 PostgreSQL이 낸 오류**로 본다 (종료 루틴 자체 점검 1). 합성 오류로는 PostgreSQL이 문장의 어디에 값을 싣는지 모른다 —
 * 데이터 예외(SQLSTATE 22)는 받은 값을 문장 본문에 따옴표로 싣는다. 로그에 가는 한 줄(`errorText`)에 그 값이 없어야 한다 (7절)
 */

let db: TestDb;
beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);

async function failure(q: Promise<unknown>): Promise<unknown> {
  try {
    await q;
  } catch (e) {
    return e;
  }
  throw new Error('실패하지 않았다');
}

const secret = '비밀-질문-본문-XYZ';

describe('errorText — 실제 PostgreSQL 오류', () => {
  it('**데이터 예외는 문장 속 값을 가린다** — 22P02(uuid)·22003(범위)·22007(시각)', async () => {
    const cases = [
      { q: sql`SELECT ${secret}::uuid`, code: '22P02', value: secret },
      { q: sql`SELECT ${'9'.repeat(21)}::int`, code: '22003', value: '9'.repeat(21) },
      { q: sql`SELECT ${secret}::timestamptz`, code: '22007', value: secret },
    ];
    for (const c of cases) {
      const e = await failure(db.execute(c.q));
      // drizzle의 문장에는 매개변수가, PostgreSQL의 문장에는 값이 있다 — 그래서 거른다
      expect(String((e as Error).message)).toContain(c.value);
      const text = errorText(e);
      expect(text.startsWith(`${c.code} `), text).toBe(true);
      expect(text).not.toContain(c.value);
      expect(text).toContain('"…"');
      expect(errorStack(e)?.split('\n')[0]).toBe(text);
      expect(isQueryError(e)).toBe(true);
    }
  });

  it('값 안에 따옴표가 있어도 새지 않는다', async () => {
    const e = await failure(db.execute(sql`SELECT ${'a"비밀"b'}::uuid`));
    expect(errorText(e)).toBe('22P02 invalid input syntax for type uuid: "…"');
  });

  it('그 밖의 부류는 문장을 싣는다 — 표·제약의 이름이 까닭이다', async () => {
    const e = await failure(db.execute(sql`SELECT * FROM no_such_table_p10`));
    expect(errorText(e)).toBe('42P01 relation "no_such_table_p10" does not exist');
  });
});
