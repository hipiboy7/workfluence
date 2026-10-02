import type { Role } from '@workfluence/shared';
import { toSessionUser, type SessionUser } from '../auth/auth.guard';
import { pages, users } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';
import type { TestDb } from './db';

/** 유스케이스 시험의 사람 — 실제 사용자 행을 넣고 가드가 만드는 것과 같은 요청의 사용자를 돌려준다 (`toSessionUser`) */
export async function person(db: TestDb, username: string, role: Role = 'member', over: Partial<typeof users.$inferInsert> = {}): Promise<SessionUser> {
  const [u] = await db.insert(users).values({ username, displayName: username, passwordHash: 'x', role, status: 'active', ...over }).returning();
  return toSessionUser(u!);
}

/** 팀 스페이스 하나와 그 안의 페이지 하나 — `me`가 주인이다 */
export async function teamPage(db: TestDb, spaces: { create: SpacesService['create'] }, me: SessionUser, title = 'T'): Promise<{ spaceId: string; pageId: string }> {
  const sp = await spaces.create({ name: '팀', kind: 'team', categoryId: null, description: '' }, me);
  const [p] = await db
    .insert(pages)
    .values({ spaceId: sp.id, parentId: null, title, position: 0, currentVersionNo: 1, searchText: '', createdBy: me.id, updatedBy: me.id })
    .returning();
  return { spaceId: sp.id, pageId: p!.id };
}
