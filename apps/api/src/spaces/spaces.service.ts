import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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

/**
 * DB 행을 판정 함수가 받는 모양으로 좁힌다.
 *
 * `kind`·`status`는 스키마에서 `text`다. 값의 범위는 서비스가 지키고 있지만 타입은 넓다.
 * **DB에 CHECK 제약이 없다** — 잘못된 값이 들어가면 판정이 조용히 기본 분기로 떨어진다.
 * Phase 4에서 상태가 늘 때 제약을 함께 넣는다 (P2_설계서_Page 8절 인계).
 */
const asSpaceLike = (s: SpaceRow) => ({ ...s, kind: s.kind as SpaceView['kind'], status: s.status as SpaceView['status'] });

@Injectable()
export class SpacesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 접근 컨텍스트. **읽을 수 없으면 404다** (403이 아니다).
   * 403을 주면 "그 스페이스는 있다"가 새어 나간다 — Phase 1의 계정 열거 방지와 같은 판단이다.
   */
  async context(spaceId: string, principal: Principal, tx: Db = this.db): Promise<SpaceContext> {
    const space = await tx.query.spaces.findFirst({ where: and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)) });
    if (!space) throw new NotFoundException('스페이스를 찾을 수 없다');

    const mine = await tx.query.spaceMembers.findFirst({
      where: and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, principal.id)),
    });
    const [{ n }] = await tx.select({ n: count() }).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
    const membership = (mine?.role as SpaceMemberRole | undefined) ?? null;
    const access = spaceAccess(principal, asSpaceLike(space), membership, n);

    if (!access.canRead) throw new NotFoundException('스페이스를 찾을 수 없다');
    return { space, membership, memberCount: n, access };
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
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        kind: row.kind as SpaceView['kind'],
        status: row.status as SpaceView['status'],
        categoryId: row.categoryId,
        categoryName: (row.categoryId && categoryOf.get(row.categoryId)) ?? null,
        createdBy: row.createdBy,
        createdByUsername: usernameOf.get(row.createdBy) ?? '',
        memberCount: n,
        myRole: membership,
        // 화면이 규칙을 다시 구현하지 않도록 판정 결과를 실어 보낸다 (FR-304)
        access: spaceAccess(principal, asSpaceLike(row), membership, n),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /**
   * 목록 (FR-310). `all`은 `space.manage` 권한자만.
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
    if (scope === 'all' && !can(principal, 'space.manage')) {
      throw new ForbiddenException('전체 스페이스를 볼 권한이 없다');
    }
    const mineIds = await this.db
      .select({ id: spaceMembers.spaceId })
      .from(spaceMembers)
      .where(eq(spaceMembers.userId, principal.id));
    const ids = mineIds.map((r) => r.id);

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
    // **모든 스페이스는 SQL에서 자른다** (P14 병합 전 검토) — 관리자에게는 `canRead`가 늘 참이라 걸러질 것이 없다. 다른 범위는 볼 수 없는 것을
    // 먼저 빼고 자른다(아래). 보기는 한꺼번에 만든다(`toViews` — 질의 넷)
    const rows = scope === 'all' ? await query.limit(limit) : await query;
    const views = await this.toViews(rows, principal);
    // 볼 수 없는 것을 먼저 빼고 자른다. 자르고 거르면 결과가 조용히 비는 수가 있다
    return views.filter((v) => v.access.canRead).slice(0, limit);
  }

  async get(spaceId: string, principal: Principal): Promise<SpaceView> {
    const { space } = await this.context(spaceId, principal);
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
      .returning();
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
   * 이름·설명·분류 변경. **쓰기 권한이 아니라 소유 권한을 본다.**
   * editor는 글을 쓰는 사람이지 공간의 정체성을 바꾸는 사람이 아니다.
   */
  async update(spaceId: string, dto: UpdateSpaceDto, principal: Principal, tx: Db = this.db): Promise<SpaceRow> {
    const ctx = await this.context(spaceId, principal, tx);
    if (!ctx.access.canChangeStatus) throw new ForbiddenException('스페이스 정보를 바꿀 권한이 없다');
    if (!ctx.access.canWrite) throw new ForbiddenException('중지된 스페이스는 바꿀 수 없다');
    if (dto.categoryId) {
      const c = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, dto.categoryId) });
      if (!c) throw new BadRequestException('없는 분류다');
    }
    const [row] = await tx
      .update(spaces)
      .set({ ...dto, updatedAt: sql`now()` })
      .where(eq(spaces.id, spaceId))
      .returning();
    return row;
  }

  async changeStatus(spaceId: string, status: 'active' | 'suspended', principal: Principal, tx: Db = this.db): Promise<SpaceRow> {
    const ctx = await this.context(spaceId, principal, tx);
    if (!ctx.access.canChangeStatus) throw new ForbiddenException('상태를 바꿀 권한이 없다');
    const [row] = await tx
      .update(spaces)
      .set({
        status,
        suspendedAt: status === 'suspended' ? sql`now()` : null,
        suspendedBy: status === 'suspended' ? principal.id : null,
        updatedAt: sql`now()`,
      })
      .where(eq(spaces.id, spaceId))
      .returning();
    return row;
  }

  /** 삭제 (FR-307). Crew가 둘 이상이면 소유자도 못 지우고, 중지되면 관리자만 지운다(P14) — `spaceAccess.canDelete`가 판정한다 */
  async softDelete(spaceId: string, principal: Principal, tx: Db = this.db): Promise<SpaceRow> {
    const ctx = await this.context(spaceId, principal, tx);
    if (!ctx.access.canDelete) throw new ForbiddenException('이 스페이스를 지울 권한이 없다');
    const [row] = await tx.update(spaces).set({ deletedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(spaces.id, spaceId)).returning();
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
    if (!ctx.access.canManageMembers) throw new ForbiddenException('Crew를 관리할 권한이 없다');
    return ctx;
  }

  async addMember(spaceId: string, dto: AddMemberDto, principal: Principal, tx: Db = this.db): Promise<void> {
    await this.assertManage(spaceId, principal, tx);
    const target = await tx.query.users.findFirst({ where: eq(users.username, dto.username) });
    if (!target) throw new NotFoundException('사용자를 찾을 수 없다');
    const existing = await tx.query.spaceMembers.findFirst({
      where: and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, target.id)),
    });
    if (existing) throw new BadRequestException('이미 Crew에 있다');
    await tx.insert(spaceMembers).values({ spaceId, userId: target.id, role: dto.role, addedBy: principal.id });
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
    await this.assertManage(spaceId, principal, tx);
    await this.assertNotLastOwner(spaceId, userId, tx);
    const r = await tx
      .update(spaceMembers)
      .set({ role })
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
      .returning();
    if (!r.length) throw new NotFoundException('Crew에 없는 사용자다');
  }

  async removeMember(spaceId: string, userId: string, principal: Principal, tx: Db = this.db): Promise<void> {
    await this.assertManage(spaceId, principal, tx);
    await this.assertNotLastOwner(spaceId, userId, tx);
    const r = await tx
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
      .returning();
    if (!r.length) throw new NotFoundException('Crew에 없는 사용자다');
  }
}
