import type { Role } from '@workfluence/shared';
import { toSessionUser, type SessionUser } from '../auth/auth.guard';
import { users } from '../db/schema';
import type { TestDb } from './db';

/** 유스케이스 시험의 사람 — 실제 사용자 행을 넣고 가드가 만드는 것과 같은 요청의 사용자를 돌려준다 (`toSessionUser`) */
export async function person(db: TestDb, username: string, role: Role = 'member', over: Partial<typeof users.$inferInsert> = {}): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ username, displayName: username, passwordHash: 'x', role, status: 'active', ...over }).returning();
  return toSessionUser(u!);
}
