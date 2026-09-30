import type { AppEnv } from '@workfluence/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrl, loadEnv } from '../config/config.module';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { users } from './schema';
import { seedRoot } from './seed';

/**
 * B등급 — **시드**(최초 root 계정). 실제 PostgreSQL. **시험 DB를 넘긴다** — 인자가 없으면 `.env`의 DB에 붙는다.
 * 설치및실행가이드 5-1절과 장애대응 7.29절이 이 명령을 치라고 한다 — 떠 있는 시스템에서도 친다
 */

let db: TestDb;
const envFor = (over: Partial<AppEnv> = {}): AppEnv =>
  ({ ...loadEnv(), WF_ENV: 'test', WF_ROOT_USERNAME: 'root', WF_ROOT_PASSWORD: 'Root-initial-2026', ...over }) as AppEnv;
const seed = (over: Partial<AppEnv> = {}) => {
  const env = envFor(over);
  return seedRoot(env, databaseUrl(env));
};
const rootRow = async () => (await db.select().from(users).where(eq(users.username, 'root')))[0];
const spacesOf = async (id: string) =>
  Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM spaces WHERE created_by = ${id}`)).rows[0].n);

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(() => resetTables(db));

describe('seedRoot', () => {
  it('없으면 만든다 — 활성 root, 첫 로그인에서 비밀번호 변경 강제, 개인 스페이스', async () => {
    await expect(seed()).resolves.toBe('root 계정 생성: root (첫 로그인에서 비밀번호 변경 강제)');
    const r = await rootRow();
    expect(r).toMatchObject({ role: 'root', status: 'active', mustChangePassword: true });
    expect(await spacesOf(r.id)).toBe(1);
  });

  it('두 번 쳐도 같다 — 비밀번호를 바꾸지 않는다', async () => {
    await seed();
    const before = await rootRow();
    await expect(seed({ WF_ROOT_PASSWORD: 'Another-pw-2026' })).resolves.toBe('root 계정 이미 정상: root');
    expect((await rootRow()).passwordHash).toBe(before.passwordHash);
    expect(await spacesOf(before.id)).toBe(1);
  });

  it('**누가 먼저 그 아이디로 가입해 두었으면 root로 올리지 않고 멈춘다** — 그 사람의 비밀번호로 root가 되던 길 (병합 전 보안 검토 M1)', async () => {
    await db.insert(users).values({ username: 'root', displayName: '가입한 사람', passwordHash: 'x', role: 'member', status: 'pending' });
    await expect(seed()).rejects.toThrow(/root가 아니다.*WF_ROOT_USERNAME/);
    const r = await rootRow();
    expect(r).toMatchObject({ role: 'member', status: 'pending', passwordHash: 'x' });
    expect(await spacesOf(r.id)).toBe(0);
  });

  it('일부러 강등해 둔 계정도 되돌리지 않는다', async () => {
    await db.insert(users).values({ username: 'root', displayName: '강등됨', passwordHash: 'x', role: 'admin', status: 'active', approvedAt: new Date() });
    await expect(seed()).rejects.toThrow(/root가 아니다/);
    expect((await rootRow()).role).toBe('admin');
  });

  it('**정지된 root는 되살리지 않는다** — "이미 정상"이라고도 말하지 않는다', async () => {
    await seed();
    await db.update(users).set({ status: 'suspended' }).where(eq(users.username, 'root'));
    const line = await seed();
    expect(line).toMatch(/정지돼 있다.*되살리지 않는다/);
    expect(line).not.toMatch(/이미 정상/);
    expect((await rootRow()).status).toBe('suspended');
  });

  it('계정이 없는데 WF_ROOT_PASSWORD가 없으면 멈춘다', async () => {
    await expect(seed({ WF_ROOT_PASSWORD: undefined })).rejects.toThrow(/WF_ROOT_PASSWORD가 없다/);
    expect(await rootRow()).toBeUndefined();
  });
});
