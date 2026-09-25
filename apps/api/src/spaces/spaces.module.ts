import { Body, ConflictException, Controller, Delete, Get, Global, Inject, Module, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  addMemberDto,
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
import { count, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { byName } from '../db/order';
import { spaceCategories, spaces } from '../db/schema';
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
    return this.spaces.list(me, q.scope, q.limit);
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
      await this.spaces.changeStatus(id, dto.status, me, tx);
      await this.audit.record({ action: 'space.status.change', actorId: me.id, targetType: 'space', targetId: id, detail: dto, ip: req.ip }, tx);
    });
    return this.spaces.get(id, me);
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

/** 분류 (FR-308) */
@Controller('api/categories')
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async list(): Promise<CategoryView[]> {
    const rows = await this.db.select().from(spaceCategories).orderBy(byName(spaceCategories.name));
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() }));
  }

  /** 이름 변경 (FR-532). 관리자만 — 남이 쓰는 분류의 이름을 아무나 바꾸면 안 된다 */
  @Patch(':id')
  @RequireAction('space.manage')
  async rename(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(createCategoryDto)) dto: ReturnType<typeof createCategoryDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CategoryView> {
    return this.db.transaction(async (tx) => {
      const row = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, id) });
      if (!row) throw new NotFoundException('분류를 찾을 수 없다');
      const dup = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, dto.name) });
      if (dup && dup.id !== id) throw new ConflictException('같은 이름의 분류가 이미 있다');
      const [next] = await tx.update(spaceCategories).set({ name: dto.name }).where(eq(spaceCategories.id, id)).returning();
      await this.audit.record(
        { action: 'category.update', actorId: me.id, targetType: 'category', targetId: id, detail: { before: row.name, after: dto.name }, ip: req.ip },
        tx,
      );
      return { id: next.id, name: next.name, createdAt: next.createdAt.toISOString() };
    });
  }

  /**
   * 삭제 (FR-532). **쓰는 스페이스가 있으면 거부한다.**
   *
   * 조용히 `NULL`로 만들면 그 스페이스들이 어느 분류였는지 복구할 수 없다 —
   * 되돌릴 수 없는 일은 막고 이유를 말하는 편이 낫다.
   */
  @Delete(':id')
  @RequireAction('space.manage')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const row = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, id) });
      if (!row) throw new NotFoundException('분류를 찾을 수 없다');
      // **지워진 스페이스도 센다.** soft delete는 `category_id`를 그대로 두고 FK도 살아
      // 있어서, 빼고 세면 검사를 통과한 뒤 DELETE가 FK로 터져 **500**이 된다 —
      // "막고 이유를 말한다"는 FR-538의 취지가 불투명한 오류로 무너진다 (코드 리뷰 4).
      // 게다가 그 `category_id`는 스페이스를 되살릴 때 필요하다
      const [{ n }] = await tx.select({ n: count() }).from(spaces).where(eq(spaces.categoryId, id));
      if (n > 0) throw new ConflictException(`이 분류를 쓰는 스페이스가 ${n}개 있다(휴지통 포함). 먼저 옮긴 뒤 지운다`);
      await tx.delete(spaceCategories).where(eq(spaceCategories.id, id));
      await this.audit.record({ action: 'category.delete', actorId: me.id, targetType: 'category', targetId: id, detail: { name: row.name }, ip: req.ip }, tx);
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
      const dup = await tx.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, dto.name) });
      if (dup) return { id: dup.id, name: dup.name, createdAt: dup.createdAt.toISOString() };
      const [row] = await tx.insert(spaceCategories).values({ name: dto.name, createdBy: me.id }).returning();
      await this.audit.record({ action: 'category.create', actorId: me.id, targetType: 'category', targetId: row.id, detail: dto, ip: req.ip }, tx);
      return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
    });
  }
}

/** 전역: PagesService와 UsersService(개인 스페이스 자동 생성)가 SpacesService를 쓴다 */
@Global()
@Module({
  providers: [SpacesService],
  controllers: [SpacesController, CategoriesController],
  exports: [SpacesService],
})
export class SpacesModule {}
