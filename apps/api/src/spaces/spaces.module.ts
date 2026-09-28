import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Global,
  Inject,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  addMemberDto,
  categoryAccess,
  createCategoryDto,
  createSpaceDto,
  spaceListQueryDto,
  spaceStatusDto,
  updateMemberRoleDto,
  updateSpaceDto,
  type CategoryView,
  type SpaceMemberView,
  type SpaceView,
} from '@workfluence/shared';
import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { byName } from '../db/order';
import { spaceCategories, spaceMembers, spaces, type SpaceCategoryRow } from '../db/schema';
import { SpacesService } from './spaces.service';

/** 스페이스 API (P2_설계서_Page 2절). 쓰기는 감사로그와 같은 트랜잭션이다 */
@Controller('api/spaces')
@UseGuards(AuthGuard)
export class SpacesController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async list(
    @Query(new ZodPipe(spaceListQueryDto)) q: ReturnType<typeof spaceListQueryDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<SpaceView[]> {
    return this.spaces.list(me, q.scope, q.limit, { q: q.q, status: q.status });
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<SpaceView> {
    return this.spaces.get(id, me);
  }

  @Post()
  @RequireAction('space.create')
  async create(
    @Body(new ZodPipe(createSpaceDto)) dto: ReturnType<typeof createSpaceDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceView> {
    const row = await this.db.transaction(async (tx) => {
      const r = await this.spaces.create(dto, me, tx);
      await this.audit.record(
        { action: 'space.create', actorId: me.id, targetType: 'space', targetId: r.id, detail: { name: r.name, kind: r.kind }, ip: req.ip },
        tx,
      );
      return r;
    });
    return this.spaces.get(row.id, me);
  }

  @Patch(':id')
  async update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateSpaceDto)) dto: ReturnType<typeof updateSpaceDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceView> {
    await this.db.transaction(async (tx) => {
      await this.spaces.update(id, dto, me, tx);
      await this.audit.record({ action: 'space.update', actorId: me.id, targetType: 'space', targetId: id, detail: dto, ip: req.ip }, tx);
    });
    return this.spaces.get(id, me);
  }

  @Patch(':id/status')
  async changeStatus(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(spaceStatusDto)) dto: ReturnType<typeof spaceStatusDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceView> {
    await this.db.transaction(async (tx) => {
      const { row, changed } = await this.spaces.changeStatus(id, dto.status, me, tx);
      // 같은 상태를 다시 보내면 쓰지 않고 감사 행도 남기지 않는다. 중지는 건 사람이 주인이었는지를 함께 남긴다 (P15 FR-1610)
      if (!changed) return;
      const detail = dto.status === 'suspended' ? { ...dto, byOwner: row.suspendedByOwner } : dto;
      await this.audit.record({ action: 'space.status.change', actorId: me.id, targetType: 'space', targetId: id, detail, ip: req.ip }, tx);
    });
    // 읽지 못해도 바꿀 수 있는 사람(스페이스 관리 전체)에게 바꾼 뒤 404를 주지 않는다
    return this.spaces.getManaged(id, me);
  }

  @Delete(':id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const row = await this.spaces.softDelete(id, me, tx);
      await this.audit.record({ action: 'space.delete', actorId: me.id, targetType: 'space', targetId: id, detail: { name: row.name }, ip: req.ip }, tx);
    });
    return { ok: true };
  }

  // ---- Crew ----

  @Get(':id/members')
  members(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<SpaceMemberView[]> {
    return this.spaces.members(id, me);
  }

  @Post(':id/members')
  async addMember(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(addMemberDto)) dto: ReturnType<typeof addMemberDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceMemberView[]> {
    await this.db.transaction(async (tx) => {
      await this.spaces.addMember(id, dto, me, tx);
      await this.audit.record({ action: 'space.member.add', actorId: me.id, targetType: 'space', targetId: id, detail: dto, ip: req.ip }, tx);
    });
    return this.spaces.members(id, me);
  }

  @Patch(':id/members/:userId')
  async changeMemberRole(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @Body(new ZodPipe(updateMemberRoleDto)) dto: ReturnType<typeof updateMemberRoleDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceMemberView[]> {
    await this.db.transaction(async (tx) => {
      await this.spaces.changeMemberRole(id, userId, dto.role, me, tx);
      await this.audit.record(
        { action: 'space.member.role.change', actorId: me.id, targetType: 'space', targetId: id, detail: { userId, role: dto.role }, ip: req.ip },
        tx,
      );
    });
    return this.spaces.members(id, me);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceMemberView[]> {
    await this.db.transaction(async (tx) => {
      await this.spaces.removeMember(id, userId, me, tx);
      await this.audit.record({ action: 'space.member.remove', actorId: me.id, targetType: 'space', targetId: id, detail: { userId }, ip: req.ip }, tx);
    });
    return this.spaces.members(id, me);
  }
}

/**
 * 분류 (FR-308 · P15 D.4). 만들기는 누구나(`category.create`). **이름 바꾸기·지우기는 판정이 한다**(`categoryAccess` — 만든 사람은 남의 공간이 쓰지
 * 않을 때, 관리자와 분류 관리를 받은 사람은 늘). 가드는 로그인만 본다 — 판정은 트랜잭션 안에서 분류 행을 잠그고 쓰임을 센 뒤에 한다
 */
@Controller('api/categories')
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async list(@CurrentUser() me: SessionUser): Promise<CategoryView[]> {
    const rows = await this.db.select().from(spaceCategories).orderBy(byName(spaceCategories.name));
    const usage = await this.usageOf(this.db);
    return rows.map((r) => toCategoryView(r, usage.get(r.id), me));
  }

  /** 이름 변경 (FR-532 · P15 FR-1621). 남이 쓰는 분류의 이름을 만든 사람이 바꾸면 남의 공간의 분류가 바뀐 것과 같다 — 지우기와 같은 규칙이다(A.1-7) */
  @Patch(':id')
  async rename(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(createCategoryDto)) dto: ReturnType<typeof createCategoryDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CategoryView> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockCategory(tx, id);
      const usage = (await this.usageOf(tx, [id])).get(id);
      if (!categoryAccess(me, row, usage ?? NO_USAGE).canRename) throw new ForbiddenException(deniedWhy(me, row, '이름을 바꾼다'));
      const dup = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, dto.name) });
      if (dup && dup.id !== id) throw new ConflictException('같은 이름의 분류가 이미 있다');
      const [next] = await tx.update(spaceCategories).set({ name: dto.name }).where(eq(spaceCategories.id, id)).returning().catch(sameName);
      await this.audit.record(
        { action: 'category.update', actorId: me.id, targetType: 'category', targetId: id, detail: { before: row.name, after: dto.name }, ip: req.ip },
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
  @Delete(':id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
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
          ip: req.ip,
        },
        tx,
      );
    });
    return { ok: true };
  }

  @Post()
  @RequireAction('category.create')
  async create(
    @Body(new ZodPipe(createCategoryDto)) dto: ReturnType<typeof createCategoryDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CategoryView> {
    return this.db.transaction(async (tx) => {
      // **같은 이름이면 있던 것을 돌려준다**(FR-308, 멱등). 먼저 찾고 넣으면 두 번 누른 두 요청이 둘 다 "없다"를 보고 둘째가 유일 제약에 걸려 500이었다
      // (P14 반영분 점검 11) — 넣기를 제약에 맡기고, 넣지 못했으면 있던 것을 읽는다
      const [row] = await tx.insert(spaceCategories).values({ name: dto.name, createdBy: me.id }).onConflictDoNothing({ target: spaceCategories.name }).returning();
      if (!row) {
        const dup = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, dto.name) });
        if (!dup) throw new ConflictException('같은 이름의 분류를 방금 누가 바꿨다 — 다시 한다');
        return toCategoryView(dup, (await this.usageOf(tx, [dup.id])).get(dup.id), me);
      }
      await this.audit.record({ action: 'category.create', actorId: me.id, targetType: 'category', targetId: row.id, detail: dto, ip: req.ip }, tx);
      return toCategoryView(row, NO_USAGE, me);
    });
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
  private async usageOf(tx: Db, ids?: readonly string[]): Promise<Map<string, CategoryView['usage']>> {
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

const NO_USAGE: CategoryView['usage'] = { spaces: 0, otherSpaces: 0 };

function toCategoryView(row: SpaceCategoryRow, usage: CategoryView['usage'] | undefined, me: SessionUser): CategoryView {
  const u = usage ?? NO_USAGE;
  return { id: row.id, name: row.name, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), access: categoryAccess(me, row, u), usage: u };
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

/** 전역: PagesService와 UsersService(개인 스페이스 자동 생성)가 SpacesService를 쓴다 */
@Global()
@Module({
  providers: [SpacesService],
  controllers: [SpacesController, CategoriesController],
  exports: [SpacesService],
})
export class SpacesModule {}
