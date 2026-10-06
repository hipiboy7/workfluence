import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, categoryAccess, type CategoryView, type CreateCategoryDto } from '@workfluence/shared';
import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { byName } from '../db/order';
import { spaceCategories, spaceMembers, spaces, type SpaceCategoryRow } from '../db/schema';

/**
 * 분류 (FR-308 · P15 D.4). 만들기는 누구나(`category.create` — 경로의 가드가 본다). **이름 바꾸기·지우기는 판정이 한다**(`categoryAccess` — 만든
 * 사람은 남의 공간이 쓰지 않을 때, 관리자와 분류 관리를 받은 사람은 늘). 판정은 트랜잭션 안에서 분류 행을 잠그고 쓰임을 센 뒤에 한다.
 * 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절)
 */
@Injectable()
export class CategoryUseCases {
  constructor(
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async list(me: SessionUser): Promise<CategoryView[]> {
    const rows = await this.db.select().from(spaceCategories).orderBy(byName(spaceCategories.name));
    const usage = await this.usageOf(this.db);
    return rows.map((r) => toCategoryView(r, usage.get(r.id), me));
  }

  create(dto: CreateCategoryDto, me: SessionUser, meta: RequestMeta): Promise<CategoryView> {
    return this.db.transaction(async (tx) => {
      // **같은 이름이면 있던 것을 돌려준다**(FR-308, 멱등). 먼저 찾고 넣으면 두 번 누른 두 요청이 둘 다 "없다"를 보고 둘째가 유일 제약에 걸려 500이었다
      // (P14 반영분 점검 11) — 넣기를 제약에 맡기고, 넣지 못했으면 있던 것을 읽는다
      const [row] = await tx.insert(spaceCategories).values({ name: dto.name, createdBy: me.id }).onConflictDoNothing({ target: spaceCategories.name }).returning();
      if (!row) {
        const dup = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, dto.name) });
        if (!dup) throw new ConflictException('같은 이름의 분류를 방금 누가 바꿨다 — 다시 한다');
        return toCategoryView(dup, (await this.usageOf(tx, [dup.id])).get(dup.id), me);
      }
      await this.audit.record({ action: 'category.create', actorId: me.id, targetType: 'category', targetId: row.id, detail: dto, ip: meta.ip }, tx);
      return toCategoryView(row, NO_USAGE, me);
    });
  }

  /** 이름 변경 (FR-532 · P15 FR-1621). 남이 쓰는 분류의 이름을 만든 사람이 바꾸면 남의 공간의 분류가 바뀐 것과 같다 — 지우기와 같은 규칙이다(A.1-7) */
  rename(id: string, dto: CreateCategoryDto, me: SessionUser, meta: RequestMeta): Promise<CategoryView> {
    return this.db.transaction(async (tx) => {
      await this.mayTouch(tx, id, me, '이름을 바꾼다');
      const row = await this.lockCategory(tx, id);
      const usage = (await this.usageOf(tx, [id])).get(id);
      if (!categoryAccess(me, row, usage ?? NO_USAGE).canRename) throw new ForbiddenException(deniedWhy(me, row, '이름을 바꾼다'));
      const dup = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, dto.name) });
      if (dup && dup.id !== id) throw new ConflictException('같은 이름의 분류가 이미 있다');
      const [next] = await tx.update(spaceCategories).set({ name: dto.name }).where(eq(spaceCategories.id, id)).returning().catch(sameName);
      await this.audit.record(
        { action: 'category.update', actorId: me.id, targetType: 'category', targetId: id, detail: { before: row.name, after: dto.name }, ip: meta.ip },
        tx,
      );
      return toCategoryView(next, usage, me);
    });
  }

  /**
   * 삭제 (FR-532 · P15 FR-1621·1622). **쓰던 공간은 분류 없음이 된다**(휴지통의 공간도) — 어느 공간이었는지 감사 `category.delete`에 남는다(`cleared`).
   * P4 FR-538은 "쓰는 공간이 있으면 막는다"였다 — 어느 분류였는지 복구할 수 없어서였다. 사용자가 바꿨고(착수 쟁점 3), 감사의 목록이 다시 붙일 길이다.
   *
   * 분류 행을 **잠그고** 센다. 공간에 분류를 붙이는 쓰기(외래 키 검사)가 그 잠금 뒤에 줄을 선다 — 세고 지우는 사이 새로 붙은 공간이 생기지 않고,
   * 기다린 쪽은 지워진 분류를 만나 400이다(`SpacesService`)
   */
  async remove(id: string, me: SessionUser, meta: RequestMeta): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      await this.mayTouch(tx, id, me, '지운다');
      const row = await this.lockCategory(tx, id);
      const usage = (await this.usageOf(tx, [id])).get(id);
      if (!categoryAccess(me, row, usage ?? NO_USAGE).canDelete) throw new ForbiddenException(deniedWhy(me, row, '지운다'));
      const cleared = await tx
        .update(spaces)
        .set({ categoryId: null, updatedAt: sql`now()` })
        .where(eq(spaces.categoryId, id))
        .returning({ id: spaces.id, name: spaces.name, deletedAt: spaces.deletedAt });
      await tx.delete(spaceCategories).where(eq(spaceCategories.id, id));
      await this.audit.record(
        {
          action: 'category.delete',
          actorId: me.id,
          targetType: 'category',
          targetId: id,
          detail: { name: row.name, cleared: cleared.map((c) => ({ id: c.id, name: c.name, deleted: c.deletedAt !== null })) },
          ip: meta.ip,
        },
        tx,
      );
    });
    return { ok: true };
  }

  /**
   * **권한 없는 사람은 줄에 서지 않는다** — 만든 사람도 분류 관리도 아니면 잠그기 전에 403이다(만든 사람은 바뀌지 않는다). 잠금 뒤에 서면 그 사람도
   * 연결을 쥐고 기다리고, 그 분류를 붙이는 공간 쓰기가 그 뒤에 선다(병합 전 보안 검토 후보 c — P14의 트리 잠금과 같은 원칙). 판정의 나머지(남의
   * 공간이 쓰는가)는 잠근 뒤에 한다
   */
  private async mayTouch(tx: Db, id: string, me: SessionUser, verb: string): Promise<void> {
    const row = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, id) });
    if (!row) throw new NotFoundException('분류를 찾을 수 없다');
    if (row.createdBy !== me.id && !can(me, 'category.manage')) throw new ForbiddenException(deniedWhy(me, row, verb));
  }

  /** 분류 행을 잠그고 읽는다 — 없으면 404. **트랜잭션 안에서 부른다** (잠금은 트랜잭션이 끝날 때 풀린다) */
  private async lockCategory(tx: Db, id: string): Promise<SpaceCategoryRow> {
    const [row] = await tx.select().from(spaceCategories).where(eq(spaceCategories.id, id)).for('update');
    if (!row) throw new NotFoundException('분류를 찾을 수 없다');
    return row;
  }

  /**
   * **쓰임** (P15 D.4) — 분류마다 그 분류를 쓰는 공간(휴지통 포함)의 수와, 그 가운데 **만든 사람이 주인이 아닌** 공간의 수. 주인은 공간을 만든
   * 사람이거나 Crew의 owner다(`spaceAccess.isOwner`와 같다). 질의 하나로 센다 — 분류마다 치지 않는다
   */
  private async usageOf(tx: Db, ids?: readonly string[]): Promise<Map<string, CategoryUsage>> {
    if (ids && !ids.length) return new Map();
    const rows = await tx
      .select({
        id: spaces.categoryId,
        spaces: sql<number>`count(*)::int`,
        otherSpaces: sql<number>`(count(*) FILTER (WHERE ${spaces.createdBy} <> ${spaceCategories.createdBy} AND NOT EXISTS (
          SELECT 1 FROM ${spaceMembers} WHERE ${spaceMembers.spaceId} = ${spaces.id} AND ${spaceMembers.userId} = ${spaceCategories.createdBy} AND ${spaceMembers.role} = 'owner'
        )))::int`,
      })
      .from(spaces)
      .innerJoin(spaceCategories, eq(spaceCategories.id, spaces.categoryId))
      .where(ids ? inArray(spaces.categoryId, [...ids]) : isNotNull(spaces.categoryId))
      .groupBy(spaces.categoryId);
    return new Map(rows.flatMap((r) => (r.id ? [[r.id, { spaces: r.spaces, otherSpaces: r.otherSpaces }] as const] : [])));
  }
}

type CategoryUsage = { spaces: number; otherSpaces: number };
const NO_USAGE: CategoryUsage = { spaces: 0, otherSpaces: 0 };

/**
 * 줄 하나. **쓰임은 바꿀 수 있는 사람과 만든 사람에게만 싣는다** — 수에는 남의 개인 공간·읽지 못하는 팀 공간·휴지통이 든다. 지우기 전에 몇 개가
 * 분류 없음이 되는지 물어야 하는 사람(FR-1624)과 "왜 못 지우나"를 알아야 하는 만든 사람만 본다(병합 전 검토 셋이 짚은 드러남)
 */
function toCategoryView(row: SpaceCategoryRow, usage: CategoryUsage | undefined, me: SessionUser): CategoryView {
  const u = usage ?? NO_USAGE;
  const access = categoryAccess(me, row, u);
  const shown = access.canRename || access.canDelete || row.createdBy === me.id;
  return { id: row.id, name: row.name, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), access, usage: shown ? u : null };
}

/** 거절의 까닭 — 만든 사람이면 남의 공간이 써서, 아니면 만든 사람이 아니어서다 */
function deniedWhy(me: SessionUser, row: SpaceCategoryRow, verb: string): string {
  return row.createdBy === me.id
    ? `남의 공간이 쓰는 분류는 관리자나 '분류 관리'를 받은 사람이 ${verb}`
    : `분류는 만든 사람과 관리자가 ${verb}`;
}

/** 이름이 겹쳤다(유일 제약 23505) — 앞의 확인과 쓰기 사이에 누가 같은 이름을 만들었다. 500이 아니라 409 */
function sameName(e: unknown): never {
  const codeOf = (x: unknown) => (typeof x === 'object' && x !== null && 'code' in x ? (x as { code?: unknown }).code : undefined);
  if (codeOf(e) === '23505' || codeOf((e as { cause?: unknown } | null)?.cause) === '23505') throw new ConflictException('같은 이름의 분류가 이미 있다');
  throw e;
}
