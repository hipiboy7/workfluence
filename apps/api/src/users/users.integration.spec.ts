import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listUsersDto } from '@workfluence/shared';
import { users } from '../db/schema';
import { loadEnv } from '../config/config.module';
import { RevocationBus } from '../common/revocation.bus';
import { SettingsService } from '../settings/settings.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { UsersService } from './users.service';

/**
 * B등급 — **사용자 목록의 찾기·거르기·나누기** (P13 C.6, FR-1450~1452). 실제 PostgreSQL.
 * 기본 100명에서 조용히 끊겨, 300명 규모에서 200명을 관리 화면에서 찾지 못했다.
 */

let db: TestDb;
let svc: UsersService;

beforeAll(async () => {
  ({ db } = await openTestDb());
  svc = new UsersService(db, new SettingsService(db, loadEnv()), new RevocationBus());
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

const list = (q: Record<string, unknown> = {}) => svc.list(listUsersDto.parse(q));

async function seed(n: number) {
  const base = Date.parse('2026-09-01T00:00:00Z');
  await db.insert(users).values(
    Array.from({ length: n }, (_, i) => ({
      username: `user${String(i).padStart(3, '0')}`,
      displayName: `사용자 ${i}`,
      email: `user${i}@example.internal`,
      passwordHash: 'x',
      role: 'member',
      status: 'active',
      createdAt: new Date(base + i * 1000),
    })),
  );
}

describe('나누기 — 한 번에 100명, 전체 수 (FR-1451)', () => {
  it('**300명이면 100명씩 셋** — 더 보기로 끝까지 닿는다', async () => {
    await seed(300);
    const first = await list();
    expect(first.total).toBe(300);
    expect(first.items).toHaveLength(100);
    expect(first.items[0].username).toBe('user299'); // 새로 온 사람부터
    const seen = new Set(first.items.map((u) => u.id));
    for (const offset of [100, 200]) {
      const page = await list({ offset });
      page.items.forEach((u) => seen.add(u.id));
    }
    expect(seen.size).toBe(300);
    expect((await list({ offset: 300 })).items).toEqual([]);
  });
});

describe('찾기 — 아이디·이름·email 부분 일치 (FR-1450)', () => {
  beforeEach(async () => {
    await db.insert(users).values([
      { username: 'alice', displayName: '앨리스', email: 'alice@example.internal', passwordHash: 'x', role: 'member', status: 'active' },
      { username: 'bob', displayName: '밥 50%', email: 'bob@example.internal', passwordHash: 'x', role: 'member', status: 'active' },
      { username: 'carol_x', displayName: '캐럴', email: 'c@corp.example.internal', passwordHash: 'x', role: 'admin', status: 'active' },
    ]);
  });

  it('아이디·이름·email 어디서든, 대소문자 없이', async () => {
    expect((await list({ q: 'ALI' })).items.map((u) => u.username)).toEqual(['alice']);
    expect((await list({ q: '캐럴' })).items.map((u) => u.username)).toEqual(['carol_x']);
    expect((await list({ q: 'corp.example' })).items.map((u) => u.username)).toEqual(['carol_x']);
    expect((await list({ q: 'ALI' })).total).toBe(1);
  });

  it('**`%`와 `_`는 글자 그대로 찾는다** — 와일드카드로 읽으면 한 글자로 전부가 나온다', async () => {
    expect((await list({ q: '%' })).items.map((u) => u.username)).toEqual(['bob']);
    expect((await list({ q: '_' })).items.map((u) => u.username)).toEqual(['carol_x']);
  });

  it('빈 찾는 말은 거르지 않는다', async () => {
    expect((await list({ q: '   ' })).total).toBe(3);
  });
});

describe('상태 거르기 — 잠김은 잠금 시각에서 판다 (FR-1450)', () => {
  beforeEach(async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    await db.insert(users).values([
      { username: 'p', displayName: 'p', passwordHash: 'x', role: 'member', status: 'pending' },
      { username: 'a', displayName: 'a', passwordHash: 'x', role: 'member', status: 'active' },
      { username: 'a-was-locked', displayName: 'w', passwordHash: 'x', role: 'member', status: 'active', lockedUntil: past, failedAttempts: 5 },
      { username: 'l', displayName: 'l', passwordHash: 'x', role: 'member', status: 'active', lockedUntil: future, failedAttempts: 5 },
      { username: 's', displayName: 's', passwordHash: 'x', role: 'member', status: 'suspended' },
    ]);
  });
  const names = async (status: string) => (await list({ status })).items.map((u) => u.username).sort();

  it('승인 대기·활성·잠김·정지', async () => {
    expect(await names('pending')).toEqual(['p']);
    expect(await names('active')).toEqual(['a', 'a-was-locked']);
    expect(await names('locked')).toEqual(['l']);
    expect(await names('suspended')).toEqual(['s']);
  });

  it('화면의 상태와 거르기가 같다 — 거른 사람은 그 상태로 보인다', async () => {
    for (const status of ['pending', 'active', 'locked', 'suspended'] as const) {
      expect((await list({ status })).items.every((u) => u.status === status), status).toBe(true);
    }
  });

  it('찾기와 거르기를 함께', async () => {
    expect((await list({ q: 'a', status: 'active' })).items.map((u) => u.username).sort()).toEqual(['a', 'a-was-locked']);
  });
});
