import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, openTestDb, type TestDb } from '../test/db';
import { byName } from './order';

/**
 * B등급 — 실제 PostgreSQL (T-046). 운영 DB의 기본 정렬(`en_US.utf8`)은 한글을 가나다 순으로 두지 않는데 개발 DB는 `C`라 시험이
 * 그 차이를 보지 못한다. 그래서 **열의 정렬을 일부러 다르게 둔 표**로 `byName`이 열·DB의 정렬을 따르지 않는다는 것을 본다.
 * 운영과 같은 정렬의 DB에서 한글 순서는 CI(postgres:17)의 지시문 목록 시험이 본다.
 */

let db: TestDb;
beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);

/** 임시 표 — 열의 정렬을 ICU(영문 대소문자를 한데 묶는다)로 둔다 */
const names = pgTable('p10_order_names', { name: text('name') });

describe('byName — 이름 정렬은 열·DB의 정렬과 무관하다', () => {
  it('**열의 정렬이 달라도 유니코드 순서다** — 한글은 가나다, 영문은 대문자가 앞', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE p10_order_names (name text COLLATE "en-US-x-icu") ON COMMIT DROP`);
      await tx.insert(names).values(['나중', 'a', '다음', 'B', '가장 먼저', '가나'].map((name) => ({ name })));
      const plain = await tx.select().from(names).orderBy(names.name);
      const ours = await tx.select().from(names).orderBy(byName(names.name));
      // 열의 정렬(ICU)은 `a`를 `B`보다 앞에 둔다 — `byName`이 그것을 따르지 않는다는 증거
      expect(plain.map((r) => r.name).slice(0, 2)).toEqual(['a', 'B']);
      expect(ours.map((r) => r.name)).toEqual(['B', 'a', '가나', '가장 먼저', '나중', '다음']);
    });
  });
});
