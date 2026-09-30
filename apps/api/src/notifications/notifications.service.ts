import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  can,
  canManageUser,
  isAdminRole,
  spaceAccess,
  type DocNode,
  type NotificationKind,
  type NotificationView,
  type Principal,
  type Role,
  type SpaceLike,
  type SpaceMemberRole,
} from '@workfluence/shared';
import { and, count, desc, eq, inArray, isNull, ne, notInArray, type SQL } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { comments, notifications, pages, spaceMembers, spaces, users, type SpaceRow } from '../db/schema';
import { callerFor, extractMentions } from './domain/mention';

/** 멘션 규칙은 이 모듈의 것이다. 실시간 편집이 문서의 멘션 자리를 찾을 때 이것을 쓴다 (P8 C.2절) */
export { scanMentions } from './domain/mention';

/** 알림을 보내는 경계 (FR-509). 지금은 앱 안 저장뿐이고, 메일·메신저는 이 뒤에 붙인다 */
export const NOTIFY = Symbol('NOTIFY');

export type NotificationDraft = {
  userId: string;
  kind: NotificationKind;
  /** 어디서 불렸나. 비밀번호 초기화 요청은 페이지가 없다 (P17) */
  pageId: string | null;
  commentId: string | null;
  /** 부른 사람. `null`이면 모른다 (P8 FR-901). 비밀번호 초기화 요청이면 요청한 사람이다 */
  actorId: string | null;
};

/** 비밀번호 초기화 요청 (P17 F-010 8번) */
const RESET_REQUEST: NotificationKind = 'password.reset.request';
/** email 확인 요청 — "이메일이 기억이 안나시나요?" (P19 FR-2009). 시스템 관리자만 받는다 */
const EMAIL_HELP: NotificationKind = 'email.confirm.request';
/** 요청한 사람이 `actor_id`인 계정 찾기 알림 — 둘 다 "로그인하지 못한다"는 같은 문제의 요청이다 (P19 C.5) */
const RECOVERY_KINDS: NotificationKind[] = [RESET_REQUEST, EMAIL_HELP];

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
  /**
   * email이 있는 사람만. 없는 계정은 앱 안 알림함으로만 받는다.
   *
   * `calledBy`는 **받는 사람별로** 부른 사람의 표시 이름이다 (P8 FR-905). 실시간 편집은
   * 사람마다 부른 사람이 다를 수 있어서 여기 싣는다. `null`이면 이 서비스는 모른다는 뜻이고,
   * 메일은 호출부가 넘긴 이름(요청한 사람)을 쓴다 — REST 저장·댓글이 그렇다.
   * `calledById`는 그 사람의 id다. 실시간 저장의 메일 감사 기록이 "누가 일으켰나"를 여기서 읽는다.
   */
  recipients: { email: string; displayName: string; calledBy: string | null; calledById: string | null }[];
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
      /**
       * 이름마다, **나온 곳마다 그 멘션을 만든 사람** (P8_설계서_Mention C.2·C.4절). 모르면 `null`.
       * 없으면 `actorId`가 전부 썼다 (REST 저장·댓글 — 요청한 사람이 쓴 사람이다).
       *
       * 실시간 편집의 자동 저장은 이것을 준다. 거기서 `actorId`는 "마지막으로 키를 누른
       * 사람"이라 멘션을 쓴 사람이 아니다. A가 `@bob`을 쓰고 bob이 다른 문단을 고치면
       * 저장의 actor가 bob이 된다 — 그것으로 부르면 **"bob 님이 불렀다"가 bob에게** 가고,
       * 자기 자신 필터를 걸면 **그 알림이 영영 사라진다** (P6 코드 리뷰 6, 보류 21).
       *
       * 받는 사람에게 누구를 말할지는 **여기서** 고른다(`callerFor`). 표에 그 이름이 없으면 **모름**이다 —
       * actor를 비운다 (FR-901).
       */
      mentionedBy?: ReadonlyMap<string, readonly (string | null)[]>;
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
    const occurrences = args.mentionedBy ?? null;
    /**
     * 받는 사람마다 누가 불렀나. REST·댓글은 요청한 사람이다.
     * 자기 자신은 부르지 않는다 — **다만 스스로 부른 것이 확실할 때만** (FR-503·902).
     * 모르면(`null`) 부른다. 불린 사람이 마침 스스로를 불렀을 수도 있지만, 그 한 건을 막으려고
     * 남이 부른 알림을 버리는 쪽이 더 나쁘다
     */
    const resolve = (u: { id: string; username: string }): { skip: boolean; caller: string | null } =>
      occurrences ? callerFor(occurrences.get(u.username), u.id) : { skip: args.actorId === u.id, caller: args.actorId };
    const candidates = mentioned.filter((u) => u.status === 'active' && !resolve(u).skip);
    if (candidates.length === 0) return none;

    const space = await tx.query.spaces.findFirst({ where: and(eq(spaces.id, args.spaceId), isNull(spaces.deletedAt)) });
    if (!space) return none;

    const members = await tx.query.spaceMembers.findMany({ where: eq(spaceMembers.spaceId, args.spaceId) });
    const n = members.length; // 같은 것을 두 번 세지 않는다
    const like = { ...space, kind: space.kind as SpaceRow['kind'] & ('personal' | 'team'), status: space.status as 'active' | 'suspended' };

    // 부른 사람의 이름은 **메일에만** 쓴다. 실시간 편집일 때만 찾는다 — REST·댓글은 호출부가 안다
    const callerIds = occurrences ? [...new Set(candidates.map((u) => resolve(u).caller).filter((x): x is string => x !== null))] : [];
    const callers = callerIds.length ? await tx.query.users.findMany({ where: inArray(users.id, callerIds) }) : [];
    const nameOf = (id: string | null): string | null => (id ? (callers.find((c) => c.id === id)?.displayName ?? null) : null);

    const drafts: NotificationDraft[] = [];
    const recipients: MentionOutcome['recipients'] = [];
    for (const u of candidates) {
      const principal: Principal = { id: u.id, role: u.role as Role };
      const membership = (members.find((m) => m.userId === u.id)?.role as SpaceMemberRole | undefined) ?? null;
      // 판정은 `shared`의 한 함수가 한다 — 여기서 다시 구현하면 검색·목록과 어긋난다
      if (!spaceAccess(principal, { kind: like.kind, status: like.status, createdBy: space.createdBy }, membership, n).canRead) continue;
      const { caller } = resolve(u);
      drafts.push({ userId: u.id, kind: 'mention', pageId: args.pageId, commentId: args.commentId ?? null, actorId: caller });
      if (u.email) recipients.push({ email: u.email, displayName: u.displayName, calledBy: nameOf(caller), calledById: occurrences ? caller : null });
    }

    await this.channel.send(drafts, tx);
    return { count: drafts.length, pageId: args.pageId, commentId: args.commentId ?? null, recipients };
  }

  /**
   * 비밀번호 초기화 요청을 **그 사람을 관리할 수 있는 관리자·시스템 관리자에게** 알린다 (P17 F-010 8번, FR-1801). 받는 사람은 사용자 관리에서
   * 초기화 단추를 누를 수 있는 사람이다 — 판정은 `canManageUser` 한 곳(위임까지 본다, P11). 자기 자신과 활성이 아닌 계정에는 보내지 않는다.
   *
   * **같은 사람의 요청을 아직 읽지 않았으면 또 만들지 않는다** (FR-1802). 로그인하지 않은 경로라 아이디와 email을 아는 누구나 되풀이할 수 있다 —
   * IP별 제한이 있어도 관리자의 알림함이 쌓인다. 만든 수를 돌려준다
   */
  async notifyPasswordResetRequest(requester: { id: string; role: Role; grants: readonly string[] }, tx: Db = this.db): Promise<number> {
    const managers = await tx
      .select({ id: users.id, role: users.role, grants: users.grants })
      .from(users)
      .where(and(inArray(users.role, ['admin', 'root']), eq(users.status, 'active')));
    const eligible = managers.filter(
      (m) => m.id !== requester.id && canManageUser({ id: m.id, role: m.role as Role, grants: m.grants }, { role: requester.role, grants: requester.grants }),
    );
    if (eligible.length === 0) return 0;
    const pending = await tx
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.kind, RESET_REQUEST),
          eq(notifications.actorId, requester.id),
          isNull(notifications.readAt),
          inArray(
            notifications.userId,
            eligible.map((m) => m.id),
          ),
        ),
      );
    const waiting = new Set(pending.map((p) => p.userId));
    const drafts: NotificationDraft[] = eligible
      .filter((m) => !waiting.has(m.id))
      .map((m) => ({ userId: m.id, kind: RESET_REQUEST, pageId: null, commentId: null, actorId: requester.id }));
    await this.channel.send(drafts, tx);
    return drafts.length;
  }

  /**
   * email 확인 요청을 **시스템 관리자에게** 알린다 (P19 FR-2009, A.1-12) — 활성 root 가운데 요청한 사람이 아닌 모두. **같은 사람의 요청을 아직 읽지
   * 않았으면 또 만들지 않는다** — 로그인하지 않은 경로라 아이디와 이름을 아는 누구나 되풀이할 수 있다(P17 FR-1802와 같은 모양). 만든 수를 돌려준다
   */
  async notifyEmailHelpRequest(requester: { id: string }, tx: Db = this.db): Promise<number> {
    const roots = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'root'), eq(users.status, 'active'), ne(users.id, requester.id)));
    if (roots.length === 0) return 0;
    const pending = await tx
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.kind, EMAIL_HELP),
          eq(notifications.actorId, requester.id),
          isNull(notifications.readAt),
          inArray(
            notifications.userId,
            roots.map((r) => r.id),
          ),
        ),
      );
    const waiting = new Set(pending.map((p) => p.userId));
    const drafts: NotificationDraft[] = roots
      .filter((r) => !waiting.has(r.id))
      .map((r) => ({ userId: r.id, kind: EMAIL_HELP, pageId: null, commentId: null, actorId: requester.id }));
    await this.channel.send(drafts, tx);
    return drafts.length;
  }

  /**
   * 그 사람의 비밀번호가 바뀌면(관리자 초기화 — P17 FR-1803, 메일 링크 재설정 — P19 FR-2006) **남은 계정 찾기 알림을 모두 읽음으로** 한다 — 초기화 요청과
   * email 확인 요청, 받은 사람 모두의 것이다. 관리자가 뒤늦게 처리하면 방금 정한 비밀번호가 임시 비밀번호로 덮인다. 비밀번호를 바꾼 트랜잭션에서 부른다.
   * 바꾼 수를 돌려준다
   */
  async resolveRecoveryRequests(requesterId: string, tx: Db = this.db): Promise<number> {
    const done = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(inArray(notifications.kind, RECOVERY_KINDS), eq(notifications.actorId, requesterId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return done.length;
  }

  /**
   * 지금 볼 수 있는 종류만 (P17 FR-1804). 비밀번호 초기화 요청은 **지금 관리자·시스템 관리자일 때만**, email 확인 요청은 **지금 시스템 관리자일 때만**
   * (P19 A.1-12) 보이고 세어진다 — 역할에서 내려가면 누가 요청했는지는 더 알 일이 아니다. 목록과 안 읽은 수가 같은 조건을 쓴다
   */
  private visibleKinds(principal: Principal): SQL | undefined {
    if (principal.role === 'root') return undefined;
    return isAdminRole(principal.role) ? ne(notifications.kind, EMAIL_HELP) : notInArray(notifications.kind, RECOVERY_KINDS);
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
        actorUsername: users.username,
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
      // **`leftJoin`이다.** 부른 사람을 모르는 알림(`actor_id` NULL)이 있다 (P8 FR-901) —
      // `innerJoin`이면 그 알림이 **목록에서 조용히 사라진다**
      .leftJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(pages, eq(pages.id, notifications.pageId))
      .leftJoin(spaces, eq(spaces.id, pages.spaceId))
      .leftJoin(spaceMembers, and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, principal.id)))
      .leftJoin(comments, eq(comments.id, notifications.commentId))
      .where(and(eq(notifications.userId, principal.id), this.visibleKinds(principal)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationKind,
      pageId: r.pageId,
      commentId: r.commentId,
      actorName: r.actorName,
      // 관리자가 사용자 관리에서 그 사람을 찾는 데만 쓴다 — 멘션에는 싣지 않는다 (P17 · P19 email 확인 요청)
      actorUsername: RECOVERY_KINDS.includes(r.kind as NotificationKind) ? r.actorUsername : null,
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
      .where(and(eq(notifications.userId, principal.id), isNull(notifications.readAt), this.visibleKinds(principal)));
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
      .where(and(eq(notifications.userId, principal.id), isNull(notifications.readAt), this.visibleKinds(principal)))
      .returning({ id: notifications.id });
    return r.length;
  }
}
