import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, spaceAccess, type DocNode, type NotificationView, type Principal, type Role, type SpaceLike, type SpaceMemberRole } from '@workfluence/shared';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { comments, notifications, pages, spaceMembers, spaces, users, type SpaceRow } from '../db/schema';
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

/**
 * 부른 사람들 — **커밋 뒤에** 메일을 보내려고 돌려준다 (FR-754).
 *
 * 외부 호출을 트랜잭션 안에 두면 연결을 쥔 채 남의 서버를 기다린다 (T-026과 같은 모양).
 * 게다가 롤백되면 **없던 일에 대한 메일이 나간다** — 메일은 되돌릴 수 없다.
 */
export type MentionOutcome = {
  count: number;
  pageId: string;
  commentId: string | null;
  /** email이 있는 사람만. 없는 계정은 앱 안 알림함으로만 받는다 */
  recipients: { email: string; displayName: string }[];
};

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
    args: {
      doc: DocNode;
      pageId: string;
      commentId?: string | null;
      spaceId: string;
      actorId: string;
      /** 직전 내용. 주면 **새로 생긴 멘션만** 부른다 (코드 리뷰 6) */
      previousDoc?: DocNode | null;
    },
    tx: Db = this.db,
  ): Promise<MentionOutcome> {
    let names = extractMentions(args.doc);
    if (args.previousDoc) {
      // **이미 불렸던 사람을 저장할 때마다 다시 부르지 않는다.** 오타 하나 고치려고 여섯 번
      // 저장하면 여섯 번 알림이 간다 — 쟁점 2에서 Watch를 뺀 이유(알림 소음)와 같은 판단이다
      const before = new Set(extractMentions(args.previousDoc));
      names = names.filter((n) => !before.has(n));
    }
    const none: MentionOutcome = { count: 0, pageId: args.pageId, commentId: args.commentId ?? null, recipients: [] };
    if (names.length === 0) return none;

    const mentioned = await tx.query.users.findMany({ where: inArray(users.username, names) });
    // 자기 자신은 부르지 않는다 (FR-503)
    const candidates = mentioned.filter((u) => u.id !== args.actorId && u.status === 'active');
    if (candidates.length === 0) return none;

    const space = await tx.query.spaces.findFirst({ where: and(eq(spaces.id, args.spaceId), isNull(spaces.deletedAt)) });
    if (!space) return none;

    const members = await tx.query.spaceMembers.findMany({ where: eq(spaceMembers.spaceId, args.spaceId) });
    const n = members.length; // 같은 것을 두 번 세지 않는다
    const like = { ...space, kind: space.kind as SpaceRow['kind'] & ('personal' | 'team'), status: space.status as 'active' | 'suspended' };

    const drafts: NotificationDraft[] = [];
    const recipients: { email: string; displayName: string }[] = [];
    for (const u of candidates) {
      const principal: Principal = { id: u.id, role: u.role as Role };
      const membership = (members.find((m) => m.userId === u.id)?.role as SpaceMemberRole | undefined) ?? null;
      // 판정은 `shared`의 한 함수가 한다 — 여기서 다시 구현하면 검색·목록과 어긋난다
      if (!spaceAccess(principal, { kind: like.kind, status: like.status, createdBy: space.createdBy }, membership, n).canRead) continue;
      drafts.push({ userId: u.id, kind: 'mention', pageId: args.pageId, commentId: args.commentId ?? null, actorId: args.actorId });
      if (u.email) recipients.push({ email: u.email, displayName: u.displayName });
    }

    await this.channel.send(drafts, tx);
    return { count: drafts.length, pageId: args.pageId, commentId: args.commentId ?? null, recipients };
  }

  /**
   * 자기 것만 본다 (FR-508). 남의 알림을 조회할 경로 자체를 두지 않는다.
   *
   * **제목은 지금 볼 수 있을 때만 준다.** 만들 때 권한을 봤어도 그 뒤 Crew에서 빠질 수
   * 있고, 그 사이 제목이 바뀌면 **최신 제목이 계속 흘러나간다.** 알림 행은 남기되
   * (FR-506) 제목만 가린다 — 판정은 검색·휴지통과 같은 조건이다.
   */
  async list(principal: Principal, limit: number, tx: Db = this.db): Promise<NotificationView[]> {
    const isAdmin = can(principal, 'space.manage');
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
        // 대상이 살아 있는지는 **페이지만으로 판단할 수 없다** (자체 점검 9).
        // 댓글이 지워졌거나 스페이스가 통째로 지워졌으면 링크는 갈 곳이 없다
        commentDeletedAt: comments.deletedAt,
        spaceDeletedAt: spaces.deletedAt,
        spaceKind: spaces.kind,
        spaceStatus: spaces.status,
        spaceCreatedBy: spaces.createdBy,
        myMembership: spaceMembers.role,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(pages, eq(pages.id, notifications.pageId))
      .leftJoin(spaces, eq(spaces.id, pages.spaceId))
      .leftJoin(spaceMembers, and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, principal.id)))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(eq(notifications.userId, principal.id))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as 'mention',
      pageId: r.pageId,
      commentId: r.commentId,
      actorName: r.actorName,
      // 대상이 지워졌거나 **지금 볼 수 없으면** 제목 대신 그 사실을 준다 (FR-506)
      pageTitle: this.visibleTitle(r, principal, isAdmin),
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }


  /**
   * 제목을 보여 줘도 되는지.
   *
   * 지워진 것(페이지·댓글·스페이스)은 물론이고 **지금 그 스페이스를 못 보면** 가린다.
   * 판정은 `spaceAccess()` 한 곳을 쓴다 — 여기서 다시 구현하면 검색·휴지통과 어긋난다.
   * `memberCount`는 읽기 판정에 쓰이지 않으므로(팀은 멤버십 유무가, 개인은 생성자가 결정한다)
   * 알림 목록마다 세지 않는다.
   */
  private visibleTitle(
    r: {
      pageTitle: string | null;
      pageDeletedAt: Date | null;
      commentDeletedAt: Date | null;
      spaceDeletedAt: Date | null;
      spaceKind: string | null;
      spaceStatus: string | null;
      spaceCreatedBy: string | null;
      myMembership: string | null;
    },
    principal: Principal,
    isAdmin: boolean,
  ): string | null {
    if (!r.pageTitle || r.pageDeletedAt || r.commentDeletedAt || r.spaceDeletedAt) return null;
    if (isAdmin) return r.pageTitle;
    if (!r.spaceKind || !r.spaceStatus || !r.spaceCreatedBy) return null;
    const access = spaceAccess(
      principal,
      { kind: r.spaceKind as SpaceLike['kind'], status: r.spaceStatus as SpaceLike['status'], createdBy: r.spaceCreatedBy },
      (r.myMembership as SpaceMemberRole | null) ?? null,
      r.myMembership ? 1 : 0,
    );
    return access.canRead ? r.pageTitle : null;
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
