import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { spaceAccess, type DocNode, type NotificationView, type Principal, type Role, type SpaceMemberRole } from '@workfluence/shared';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { notifications, pages, spaceMembers, spaces, users, type SpaceRow } from '../db/schema';
import { extractMentions } from './domain/mention';

/** 알림을 보내는 경계 (FR-509). 지금은 앱 안 저장뿐이고, 메일·메신저는 이 뒤에 붙인다 */
export const NOTIFY = Symbol('NOTIFY');

export type NotificationDraft = {
  userId: string;
  kind: 'mention';
  pageId: string;
  commentId: string | null;
  actorId: string;
};

export interface NotificationChannel {
  send(drafts: NotificationDraft[], tx: Db): Promise<void>;
}

/** 앱 안 알림함. 받는 사람이 화면에서 본다 */
@Injectable()
export class InAppChannel implements NotificationChannel {
  async send(drafts: NotificationDraft[], tx: Db): Promise<void> {
    if (drafts.length === 0) return;
    await tx.insert(notifications).values(drafts);
  }
}

/**
 * 알림 (P4_설계서_Admin C절, FR-500~509).
 *
 * **볼 수 없는 사람에게는 만들지 않는다** (FR-502). 알림이 "그런 페이지가 있다"를
 * 알려 주는 통로가 되면 안 된다 — 검색에서 막은 것을 여기서 열어 주는 셈이 된다.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NOTIFY) private readonly channel: NotificationChannel,
  ) {}

  /**
   * 문서에서 멘션을 찾아 알림을 만든다. **본 작업과 같은 트랜잭션을 받는다** —
   * 저장이 롤백되면 알림도 롤백돼야 한다. "불렀다고 알림은 왔는데 글이 없는" 상태를 막는다.
   */
  async notifyMentions(
    args: { doc: DocNode; pageId: string; commentId?: string | null; spaceId: string; actorId: string },
    tx: Db = this.db,
  ): Promise<number> {
    const names = extractMentions(args.doc);
    if (names.length === 0) return 0;

    const mentioned = await tx.query.users.findMany({ where: inArray(users.username, names) });
    // 자기 자신은 부르지 않는다 (FR-503)
    const candidates = mentioned.filter((u) => u.id !== args.actorId && u.status === 'active');
    if (candidates.length === 0) return 0;

    const space = await tx.query.spaces.findFirst({ where: and(eq(spaces.id, args.spaceId), isNull(spaces.deletedAt)) });
    if (!space) return 0;

    const members = await tx.query.spaceMembers.findMany({ where: eq(spaceMembers.spaceId, args.spaceId) });
    const [{ n }] = await tx.select({ n: count() }).from(spaceMembers).where(eq(spaceMembers.spaceId, args.spaceId));
    const like = { ...space, kind: space.kind as SpaceRow['kind'] & ('personal' | 'team'), status: space.status as 'active' | 'suspended' };

    const drafts: NotificationDraft[] = [];
    for (const u of candidates) {
      const principal: Principal = { id: u.id, role: u.role as Role };
      const membership = (members.find((m) => m.userId === u.id)?.role as SpaceMemberRole | undefined) ?? null;
      // 판정은 `shared`의 한 함수가 한다 — 여기서 다시 구현하면 검색·목록과 어긋난다
      if (!spaceAccess(principal, { kind: like.kind, status: like.status, createdBy: space.createdBy }, membership, n).canRead) continue;
      drafts.push({ userId: u.id, kind: 'mention', pageId: args.pageId, commentId: args.commentId ?? null, actorId: args.actorId });
    }

    await this.channel.send(drafts, tx);
    return drafts.length;
  }

  /** 자기 것만 본다 (FR-508). 남의 알림을 조회할 경로 자체를 두지 않는다 */
  async list(principal: Principal, limit: number, tx: Db = this.db): Promise<NotificationView[]> {
    const rows = await tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        pageId: notifications.pageId,
        commentId: notifications.commentId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        actorName: users.displayName,
        pageTitle: pages.title,
        pageDeletedAt: pages.deletedAt,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(pages, eq(pages.id, notifications.pageId))
      .where(eq(notifications.userId, principal.id))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as 'mention',
      pageId: r.pageId,
      commentId: r.commentId,
      actorName: r.actorName,
      // 대상이 지워졌으면 제목 대신 그 사실을 준다 (FR-506)
      pageTitle: r.pageDeletedAt || !r.pageTitle ? null : r.pageTitle,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async unreadCount(principal: Principal, tx: Db = this.db): Promise<number> {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, principal.id), isNull(notifications.readAt)));
    return n;
  }

  async markRead(id: string, principal: Principal, tx: Db = this.db): Promise<void> {
    const r = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, principal.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    // 이미 읽었거나 남의 것이면 아무 일도 없다. **남의 것임을 알려 주지 않는다**
    if (r.length === 0) {
      const exists = await tx.query.notifications.findFirst({ where: and(eq(notifications.id, id), eq(notifications.userId, principal.id)) });
      if (!exists) throw new NotFoundException('알림을 찾을 수 없다');
    }
  }

  async markAllRead(principal: Principal, tx: Db = this.db): Promise<number> {
    const r = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, principal.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return r.length;
  }
}
