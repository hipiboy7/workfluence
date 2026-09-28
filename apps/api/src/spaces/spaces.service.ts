import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  can,
  generateSpaceKey,
  spaceAccess,
  type AddMemberDto,
  type CreateSpaceDto,
  type Principal,
  type SpaceAccess,
  type SpaceMemberRole,
  type SpaceMemberView,
  type SpaceView,
  type UpdateSpaceDto,
} from '@workfluence/shared';
import { and, count, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { containsPattern } from '../common/like';
import { DB, type Db } from '../db/db.module';
import { byName } from '../db/order';
import { spaceCategories, spaceMembers, spaces, users, type SpaceRow } from '../db/schema';

/**
 * 스페이스 (P2_설계서_Page 2절). B등급 — 실제 PostgreSQL로 통합 테스트한다.
 *
 * **판정하지 않는다.** 스페이스 행·내 멤버십·멤버 수를 모아 `shared`의 `spaceAccess()`에
 * 넘기고 결과만 쓴다 (FR-303). 서비스가 규칙을 다시 쓰면 화면과 서버가 어긋난다.
 */

export type SpaceContext = { space: SpaceRow; membership: SpaceMemberRole | null; memberCount: number; access: SpaceAccess };

/** 관리자가 건 중지를 풀지 못하는 주인에게 주는 까닭 (P15 FR-1611·1612) — 화면(공간의 관리 칸)은 누르기 전에 까닭을 보인다 */
export const ADMIN_SUSPENDED_MESSAGE = "관리자가 중지한 스페이스다 — 다시 쓰기는 관리자나 '관리자가 건 중지 풀기'를 받은 주인이 한다";

/** 관리자가 건 중지 동안 Crew를 바꾸려는 주인에게 주는 까닭 (P16 FR-1700) — 권한을 잃은 것이 아니라 얼린 것이다 */
export const ADMIN_SUSPENDED_CREW_MESSAGE = '관리자가 중지한 스페이스다 — Crew는 관리자가 바꾼다';

/** 공간이 분류를 가리키는 외래 키 — `0002_space_page`가 지은 이름이다 */
const SPACE_CATEGORY_FK = 'spaces_category_id_space_categories_id_fk';

/**
 * **분류의** 외래 키 위반(23503) — 분류를 붙이는 사이 그 분류가 지워졌다(P15 D.4). 다른 외래 키(만든 사람 등)의 위반까지 "없는 분류다"로 바꾸지
 * 않게 제약 이름을 본다(병합 전 코드 리뷰 12). drizzle은 원래 오류를 `cause`에 싣는다
 */
function isCategoryGone(e: unknown): boolean {
  const pg = (x: unknown) => (typeof x === 'object' && x !== null ? (x as { code?: unknown; constraint?: unknown }) : undefined);
  const cause = pg((e as { cause?: unknown } | null)?.cause) ?? pg(e);
  return cause?.code === '23503' && cause.constraint === SPACE_CATEGORY_FK;
}

/**
 * DB 행을 판정 함수가 받는 모양으로 좁힌다.
 *
 * `kind`·`status`는 스키마에서 `text`다. 값의 범위는 서비스가 지키고 있지만 타입은 넓다.
 * **DB에 CHECK 제약이 없다** — 잘못된 값이 들어가면 판정이 조용히 기본 분기로 떨어진다.
 * Phase 4에서 상태가 늘 때 제약을 함께 넣는다 (P2_설계서_Page 8절 인계).
 */
const asSpaceLike = (s: SpaceRow) => ({ ...s, kind: s.kind as SpaceView['kind'], status: s.status as SpaceView['status'] });

/** 분류를 붙이는 쓰기가 지워진 분류를 만났다 — 500이 아니라 400 (P15 D.4). 분류 지우기가 분류 행을 잠가 둘을 줄 세운다 */
function noSuchCategory(e: unknown): never {
  if (isCategoryGone(e)) throw new BadRequestException('없는 분류다');
  throw e;
}

@Injectable()
export class SpacesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 접근 컨텍스트. **읽을 수 없으면 404다** (403이 아니다).
   * 403을 주면 "그 스페이스는 있다"가 새어 나간다 — Phase 1의 계정 열거 방지와 같은 판단이다.
   */
  async context(spaceId: string, principal: Principal, tx: Db = this.db): Promise<SpaceContext> {
    const ctx = await this.load(spaceId, principal, tx);
    if (!ctx.access.canRead) throw new NotFoundException('스페이스를 찾을 수 없다');
    return ctx;
  }

  /**
   * **관리 컨텍스트** (P15 D.3) — 상태 바꾸기·지우기. 읽지 못해도 판정한다: 스페이스 관리 전체(`space.oversee`)를 받은 사람은 Crew가 아닌
   * 공간도 중지한다(FR-1630). 읽을 수도 바꿀 수도 없으면 `context`처럼 404다 — 있는지 드러내지 않는다. 지울 수 있으면 바꿀 수도 있다
   * (`canDelete` ⇒ `canChangeStatus` — 주인은 활성일 때, 스페이스 관리 전체는 중지일 때)
   */
  private async manageContext(spaceId: string, principal: Principal, tx: Db): Promise<SpaceContext> {
    const ctx = await this.load(spaceId, principal, tx);
    if (!ctx.access.canRead && !ctx.access.canChangeStatus) throw new NotFoundException('스페이스를 찾을 수 없다');
    return ctx;
  }

  private async load(spaceId: string, principal: Principal, tx: Db): Promise<SpaceContext> {
    const space = await tx.query.spaces.findFirst({ where: and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)) });
    if (!space) throw new NotFoundException('스페이스를 찾을 수 없다');

    const mine = await tx.query.spaceMembers.findFirst({
      where: and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, principal.id)),
    });
    const [{ n }] = await tx.select({ n: count() }).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
    const membership = (mine?.role as SpaceMemberRole | undefined) ?? null;
    return { space, membership, memberCount: n, access: spaceAccess(principal, asSpaceLike(space), membership, n) };
  }

  async assertWrite(spaceId: string, principal: Principal, tx: Db = this.db): Promise<SpaceContext> {
    const ctx = await this.context(spaceId, principal, tx);
    if (!ctx.access.canWrite) throw new ForbiddenException('이 스페이스에 쓸 권한이 없다');
    return ctx;
  }

  private async toView(row: SpaceRow, principal: Principal, tx: Db = this.db): Promise<SpaceView> {
    return (await this.toViews([row], principal, tx))[0];
  }

  /**
   * 줄마다 보기를 만든다 — **줄 수와 무관하게 질의 넷**(내 자리·Crew 수·만든 사람·분류). 줄마다 넷을 치면 개인 스페이스만 수백 개인 모든
   * 스페이스 목록 한 번에 질의 천여 개가 연결 풀로 몰렸다(P14 반영분 점검 8, 코드 리뷰 3)
   */
  private async toViews(rows: readonly SpaceRow[], principal: Principal, tx: Db = this.db): Promise<SpaceView[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const mine = await tx
      .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(inArray(spaceMembers.spaceId, ids), eq(spaceMembers.userId, principal.id)));
    const counts = await tx
      .select({ spaceId: spaceMembers.spaceId, n: count() })
      .from(spaceMembers)
      .where(inArray(spaceMembers.spaceId, ids))
      .groupBy(spaceMembers.spaceId);
    const creators = await tx
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.createdBy))]));
    const categoryIds = [...new Set(rows.flatMap((r) => (r.categoryId ? [r.categoryId] : [])))];
    const categories = categoryIds.length
      ? await tx.select({ id: spaceCategories.id, name: spaceCategories.name }).from(spaceCategories).where(inArray(spaceCategories.id, categoryIds))
      : [];
    const roleOf = new Map(mine.map((m) => [m.spaceId, m.role as SpaceMemberRole]));
    const countOf = new Map(counts.map((c) => [c.spaceId, c.n]));
    const usernameOf = new Map(creators.map((u) => [u.id, u.username]));
    const categoryOf = new Map(categories.map((c) => [c.id, c.name]));
    return rows.map((row) => {
      const membership = roleOf.get(row.id) ?? null;
      const n = countOf.get(row.id) ?? 0;
      const access = spaceAccess(principal, asSpaceLike(row), membership, n);
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        // 읽지 못하는 사람(스페이스 관리 전체)에게는 설명을 싣지 않는다 — 목록의 칸(이름·키·주인·분류·상태)만 (P15 A.1-1)
        description: access.canRead ? row.description : '',
        kind: row.kind as SpaceView['kind'],
        status: row.status as SpaceView['status'],
        // 중지일 때만 뜻이 있다 — 누가 중지했는지(주인인가) 화면이 보인다 (P15 FR-1612)
        suspendedByOwner: row.status === 'suspended' && row.suspendedByOwner,
        categoryId: row.categoryId,
        categoryName: (row.categoryId && categoryOf.get(row.categoryId)) ?? null,
        createdBy: row.createdBy,
        createdByUsername: usernameOf.get(row.createdBy) ?? '',
        memberCount: n,
        myRole: membership,
        // 화면이 규칙을 다시 구현하지 않도록 판정 결과를 실어 보낸다 (FR-304)
        access,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /**
   * 목록 (FR-310). `all`은 **스페이스 관리 전체**(`space.oversee` — 관리자·root와 받은 사람)만 (P15 D.3). **`all`은 읽기로 거르지 않는다** —
   * 받은 사람에게는 읽지 못하는 공간도 보여야 중지하고 지운다(목록의 칸만 — `toViews`가 설명을 뺀다).
   *
   * **여기서 막는다.** 핸들러에 `@RequireAction`을 붙이면 `scope`와 무관하게 막혀 일반
   * 사용자가 자기 목록도 못 본다. 권한이 `scope` 값에 달려 있으므로 판정도 여기여야 한다.
   *
   * **찾기와 상태는 DB가 거른다** (P14 FR-1514). 자르기(`limit`) 전에 걸러야 상한 밖의 스페이스도 찾아진다 — 화면에서만 거르면 500개 밖을
   * 찾지 못한다(T-051과 같은 까닭). `q`는 이름·키의 부분 일치 — `%`·`_`는 글자 그대로 찾는다(`containsPattern`)
   */
  async list(
    principal: Principal,
    scope: 'personal' | 'team' | 'all',
    limit: number,
    filter: { q?: string; status?: SpaceRow['status'] } = {},
  ): Promise<SpaceView[]> {
    if (scope === 'all' && !can(principal, 'space.oversee')) {
      throw new ForbiddenException('전체 스페이스를 볼 권한이 없다');
    }
    // 내 Crew 자리는 내 팀 목록에만 쓴다 — 모든 스페이스에는 치지 않는다(병합 전 코드 리뷰 13)
    const ids =
      scope === 'team'
        ? (await this.db.select({ id: spaceMembers.spaceId }).from(spaceMembers).where(eq(spaceMembers.userId, principal.id))).map((r) => r.id)
        : [];

    const visible =
      scope === 'all'
        ? isNull(spaces.deletedAt)
        : and(
            isNull(spaces.deletedAt),
            scope === 'personal'
              ? and(eq(spaces.kind, 'personal'), eq(spaces.createdBy, principal.id))
              : and(eq(spaces.kind, 'team'), ids.length ? or(inArray(spaces.id, ids), eq(spaces.createdBy, principal.id)) : eq(spaces.createdBy, principal.id)),
          );

    const found = filter.q ? or(ilike(spaces.name, containsPattern(filter.q)), ilike(spaces.key, containsPattern(filter.q))) : undefined;
    const query = this.db
      .select()
      .from(spaces)
      .where(and(visible, found, filter.status ? eq(spaces.status, filter.status) : undefined))
      .orderBy(byName(spaces.name));
    // **모든 스페이스는 SQL에서 자르고 거르지 않는다** (P14 병합 전 검토 · P15 D.3). 다른 범위는 볼 수 없는 것을 먼저 빼고 자른다(아래).
    // 보기는 한꺼번에 만든다(`toViews` — 질의 넷)
    if (scope === 'all') return this.toViews(await query.limit(limit), principal);
    const views = await this.toViews(await query, principal);
    // 볼 수 없는 것을 먼저 빼고 자른다. 자르고 거르면 결과가 조용히 비는 수가 있다
    return views.filter((v) => v.access.canRead).slice(0, limit);
  }

  async get(spaceId: string, principal: Principal): Promise<SpaceView> {
    const { space } = await this.context(spaceId, principal);
    return this.toView(space, principal);
  }

  /** 상태를 바꾼 뒤 돌려주는 보기 — 읽지 못해도 바꿀 수 있는 사람(스페이스 관리 전체)에게 404를 주지 않는다 (P15 D.3) */
  async getManaged(spaceId: string, principal: Principal): Promise<SpaceView> {
    const { space } = await this.manageContext(spaceId, principal, this.db);
    return this.toView(space, principal);
  }

  /** 생성 (FR-300, FR-301). 팀이면 생성자가 owner Crew가 된다 */
  async create(dto: CreateSpaceDto, principal: Principal, tx: Db = this.db): Promise<SpaceRow> {
    if (dto.categoryId) {
      const c = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, dto.categoryId) });
      if (!c) throw new BadRequestException('없는 분류다');
    }
    const [row] = await tx
      .insert(spaces)
      .values({
        key: await this.freeKey(tx),
        name: dto.name,
        description: dto.description,
        kind: dto.kind,
        categoryId: dto.categoryId,
        createdBy: principal.id,
      })
      .returning()
      .catch(noSuchCategory);
    // 개인 스페이스는 Crew를 두지 않는다 (FR-305)
    if (dto.kind === 'team') {
      await tx.insert(spaceMembers).values({ spaceId: row.id, userId: principal.id, role: 'owner', addedBy: principal.id });
    }
    return row;
  }

  private async freeKey(tx: Db): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const key = generateSpaceKey((max) => randomInt(max));
      if (!(await tx.query.spaces.findFirst({ where: eq(spaces.key, key) }))) return key;
    }
    throw new Error('스페이스 key를 만들지 못했다');
  }

  /** 승인 시 개인 스페이스 자동 생성 (FR-309). **승인과 같은 트랜잭션에서 부른다** */
  async ensurePersonalSpace(userId: string, displayName: string, tx: Db): Promise<void> {
    const existing = await tx.query.spaces.findFirst({
      where: and(eq(spaces.kind, 'personal'), eq(spaces.createdBy, userId), isNull(spaces.deletedAt)),
    });
    if (existing) return;
    await this.create({ name: `${displayName}의 공간`, kind: 'personal', categoryId: null, description: '' }, { id: userId, role: 'member' }, tx);
  }

  /**
   * 이름·설명·분류 변경. **쓰기 권한이 아니라 소유 권한을 본다**(`canEditInfo` — 주인과 관리자, P15 A.1-1).
   * editor는 글을 쓰는 사람이지 공간의 정체성을 바꾸는 사람이 아니다. 스페이스 관리 전체를 받은 사람도 이름은 바꾸지 않는다.
   */
  async update(spaceId: string, dto: UpdateSpaceDto, principal: Principal, tx: Db = this.db): Promise<SpaceRow> {
    const ctx = await this.context(spaceId, principal, tx);
    if (!ctx.access.canEditInfo) throw new ForbiddenException('스페이스 정보를 바꿀 권한이 없다');
    if (!ctx.access.canWrite) throw new ForbiddenException('중지된 스페이스는 바꿀 수 없다');
    if (dto.categoryId) {
      const c = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, dto.categoryId) });
      if (!c) throw new BadRequestException('없는 분류다');
    }
    // 판정한 상태에서만 쓴다(A.1-14) — 이름을 바꾸는 사이 관리자가 중지하면 중지된 공간의 이름이 바뀌었다(좁은 재검토 13)
    const [row] = await tx
      .update(spaces)
      .set({ ...dto, updatedAt: sql`now()` })
      .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt), eq(spaces.status, 'active')))
      .returning()
      .catch(noSuchCategory);
    if (!row) throw new ConflictException('그 사이 누가 이 스페이스를 바꿨다 — 다시 본다');
    return row;
  }

  /**
   * 중지·다시 쓰기 (FR-306 · P15 C.2). **읽지 못해도** 판정한다(`manageContext`). 중지할 때 건 사람이 주인인지 적는다(FR-1610) — 관리자가 건
   * 중지는 `space.unsuspend`를 받은 주인만 푼다(판정은 `spaceAccess.canChangeStatus`). 풀지 못하는 주인에게는 까닭을 말한다(FR-1612).
   *
   * **상태가 같으면 쓰지 않는다. 하나만 예외다** — 주인이 아닌 사람(관리자·스페이스 관리 전체)이 **주인이 건 중지**를 다시 걸면 **넘겨받는다**
   * (`takeover` — 건 사람을 그 사람으로, 관리자가 건 중지로. 중지된 때는 그대로). 푸는 사람을 줄이기만 하는 쪽이다(병합 전 보안 검토 1 — 넘겨받는
   * 길이 없으면 주인이 먼저 다시 걸어 관리자의 중지를 늘 비켰다). 주인이 관리자가 건 중지를 다시 걸어 "주인이 건 것"으로 바꾸는 길은 없다 — 판정이
   * 푸는 것과 같은 권한을 요구한다(A.1-12).
   *
   * **판정한 상태에서만 쓴다** — 쓰기의 조건에 판정에 쓴 값(상태·건 사람이 주인인가·지워지지 않았다)을 모두 둔다. 둘이 동시에 바꾸면 뒤의 것은 앞의
   * 결과를 판정하지 않고 덮지 않고 409다. 상태만 보면, 관리자가 다시 쓰기 → 중지를 끝낸 사이 주인의 풀기가 "주인이 건 중지"로 판정한 채 관리자가
   * 건 중지를 풀었다(ABA — 병합 전 검토 셋이 따로 찾았다). 호출부는 `changed`가 거짓이면 감사 행을 남기지 않는다
   */
  async changeStatus(
    spaceId: string,
    status: 'active' | 'suspended',
    principal: Principal,
    tx: Db = this.db,
    opts: { takeover?: boolean } = {},
  ): Promise<{ row: SpaceRow; changed: boolean; takeover: boolean; wasByOwner: boolean }> {
    const ctx = await this.manageContext(spaceId, principal, tx);
    const same = ctx.space.status === status;
    const wasByOwner = ctx.space.suspendedByOwner;
    if (!ctx.access.canChangeStatus) {
      // 풀려는 주인에게만 까닭을 말한다 — 다시 걸려는 것(같은 상태)은 까닭이 다르다(병합 전 코드 리뷰 12)
      if (!same && ctx.space.status === 'suspended' && ctx.access.isOwner) throw new ForbiddenException(ADMIN_SUSPENDED_MESSAGE);
      throw new ForbiddenException('상태를 바꿀 권한이 없다');
    }
    const takeover = same && status === 'suspended' && wasByOwner && !ctx.access.isOwner;
    // **화면이 넘겨받으려 했다**(`takeover`) — 그 사이 주인이 풀었으면 새 중지로 만들지 않는다. 그러면 편집 중인 사람을 모르고 끊고 "넘겨받았다"고
    // 알렸다(좁은 재검토 12). 주인은 넘겨받지 않는다 — 제 중지다
    if (opts.takeover && ctx.access.isOwner) throw new BadRequestException('주인은 넘겨받지 않는다 — 그 중지는 주인의 것이다');
    if (opts.takeover && !takeover) throw new ConflictException('주인이 건 중지가 아니다 — 그 사이 누가 바꿨다. 다시 본다');
    if (same && !takeover) return { row: ctx.space, changed: false, takeover: false, wasByOwner };
    const [row] = await tx
      .update(spaces)
      .set(
        takeover
          ? { suspendedBy: principal.id, suspendedByOwner: false, updatedAt: sql`now()` }
          : {
              status,
              suspendedAt: status === 'suspended' ? sql`now()` : null,
              suspendedBy: status === 'suspended' ? principal.id : null,
              suspendedByOwner: status === 'suspended' && ctx.access.isOwner,
              updatedAt: sql`now()`,
            },
      )
      .where(
        and(
          eq(spaces.id, spaceId),
          isNull(spaces.deletedAt),
          eq(spaces.status, ctx.space.status),
          eq(spaces.suspendedByOwner, ctx.space.suspendedByOwner),
        ),
      )
      .returning();
    if (!row) throw new ConflictException('그 사이 누가 상태를 바꿨다 — 다시 본다');
    return { row, changed: true, takeover, wasByOwner };
  }

  /**
   * 삭제 (FR-307). Crew가 둘 이상이면 소유자도 못 지우고, 중지되면 관리자·스페이스 관리 전체만 지운다(P14 · P15) — `spaceAccess.canDelete`가 판정한다.
   * **판정한 상태에서만 지운다** — 주인의 지우기(활성으로 판정)와 관리자의 중지가 겹치면 중지된 공간을 주인이 지웠고, 스페이스 관리 전체의
   * 지우기(중지로 판정)와 주인의 다시 쓰기가 겹치면 쓰는 중인 공간이 휴지통으로 갔다. 두 번 누르면 감사가 두 줄 남았다(병합 전 검토) — 이제 409다
   */
  async softDelete(spaceId: string, principal: Principal, tx: Db = this.db): Promise<SpaceRow> {
    const ctx = await this.manageContext(spaceId, principal, tx);
    if (!ctx.access.canDelete) throw new ForbiddenException('이 스페이스를 지울 권한이 없다');
    const [row] = await tx
      .update(spaces)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt), eq(spaces.status, ctx.space.status)))
      .returning();
    if (!row) throw new ConflictException('그 사이 누가 이 스페이스를 바꿨다 — 다시 본다');
    return row;
  }

  // ---- Crew (FR-311, FR-312) ----

  async members(spaceId: string, principal: Principal): Promise<SpaceMemberView[]> {
    await this.context(spaceId, principal);
    const rows = await this.db
      .select({
        userId: spaceMembers.userId,
        username: users.username,
        displayName: users.displayName,
        role: spaceMembers.role,
        createdAt: spaceMembers.createdAt,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(eq(spaceMembers.spaceId, spaceId))
      .orderBy(byName(users.displayName));
    return rows.map((r) => ({ ...r, role: r.role as SpaceMemberRole, createdAt: r.createdAt.toISOString() }));
  }

  private async assertManage(spaceId: string, principal: Principal, tx: Db): Promise<SpaceContext> {
    const ctx = await this.context(spaceId, principal, tx);
    // 종류를 먼저 본다. 개인 스페이스는 `canManageMembers`가 언제나 false라 권한 오류가 먼저
    // 나가는데, 그러면 "권한을 받으면 되나?"로 읽힌다. 실제 이유는 Crew라는 것이 없다는 것이다
    if (ctx.space.kind !== 'team') throw new BadRequestException('개인 스페이스에는 Crew가 없다');
    if (!ctx.access.canManageMembers) {
      // 막힌 주인에게는 권한을 잃은 줄 알지 않게 까닭을 나눠 말한다(P16 A.1-3) — 얼었는지는 판정이 말한다(`crewFrozen`)
      if (ctx.access.crewFrozen) throw new ForbiddenException(ADMIN_SUSPENDED_CREW_MESSAGE);
      throw new ForbiddenException('Crew를 관리할 권한이 없다');
    }
    return ctx;
  }

  /**
   * **Crew를 바꾸는 일은 판정한 공간 상태에서만 쓴다** (P16 A.1-5 · P15 A.1-14). Crew를 바꿀 수 있는지가 공간의 상태와 중지를 건 사람에 달리므로
   * (P16), 판정 전에 공간 행을 **나눠 잠근다**(`FOR SHARE`) — 상태 바꾸기·넘겨받기·지우기는 이 트랜잭션이 끝날 때까지 기다리고, 먼저 와 있던
   * 것은 이쪽이 기다렸다가 새 상태로 판정한다. Crew를 바꾸는 일끼리는 서로 기다리지 않는다. 처음 판은 잠그지 않아 관리자의 중지가 커밋되는 사이
   * 주인의 넣기가 들어갔다(병합 전 검토 셋 — T-072). **잠금은 커밋까지 가야 하므로 늘 트랜잭션 안에서 한다** — 받은 것이 트랜잭션이면 그 안의
   * 저장점(저장점에서 잡은 행 잠금은 바깥 트랜잭션이 끝날 때까지 간다), 아니면 새 트랜잭션이다. 밖에서 그냥 부르면 잠금이 그 문장 하나로 끝나 줄
   * 세우기가 오류 없이 사라진다(`lockTree`와 같은 까닭)
   */
  private async manageMembers(spaceId: string, principal: Principal, tx: Db, write: (tx: Db) => Promise<void>): Promise<void> {
    await tx.transaction(async (t) => {
      await t.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, spaceId)).for('share');
      await this.assertManage(spaceId, principal, t);
      await write(t);
    });
  }

  async addMember(spaceId: string, dto: AddMemberDto, principal: Principal, tx: Db = this.db): Promise<void> {
    await this.manageMembers(spaceId, principal, tx, async (t) => {
      const target = await t.query.users.findFirst({ where: eq(users.username, dto.username) });
      if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
      const existing = await t.query.spaceMembers.findFirst({
        where: and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, target.id)),
      });
      if (existing) throw new BadRequestException('이미 Crew에 있다');
      await t.insert(spaceMembers).values({ spaceId, userId: target.id, role: dto.role, addedBy: principal.id });
    });
  }

  /** 마지막 owner를 강등·제거할 수 없다 (FR-312). 주인 없는 스페이스를 만들지 않는다 */
  private async assertNotLastOwner(spaceId: string, userId: string, tx: Db): Promise<void> {
    const current = await tx.query.spaceMembers.findFirst({
      where: and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)),
    });
    if (current?.role !== 'owner') return;
    const [{ n }] = await tx
      .select({ n: count() })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, 'owner')));
    if (n <= 1) throw new BadRequestException('마지막 owner는 바꾸거나 제거할 수 없다');
  }

  async changeMemberRole(spaceId: string, userId: string, role: SpaceMemberRole, principal: Principal, tx: Db = this.db): Promise<void> {
    await this.manageMembers(spaceId, principal, tx, async (t) => {
      await this.assertNotLastOwner(spaceId, userId, t);
      const r = await t
        .update(spaceMembers)
        .set({ role })
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
        .returning();
      if (!r.length) throw new NotFoundException('Crew에 없는 사용자다');
    });
  }

  async removeMember(spaceId: string, userId: string, principal: Principal, tx: Db = this.db): Promise<void> {
    await this.manageMembers(spaceId, principal, tx, async (t) => {
      await this.assertNotLastOwner(spaceId, userId, t);
      const r = await t
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
        .returning();
      if (!r.length) throw new NotFoundException('Crew에 없는 사용자다');
    });
  }
}
