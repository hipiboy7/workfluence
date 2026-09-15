import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Ip,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  addMemberDto,
  can,
  createCategoryDto,
  createSpaceDto,
  generateSpaceKey,
  spaceAccess,
  spaceListQueryDto,
  spaceStatusDto,
  updateMemberRoleDto,
  updateSpaceDto,
  type AddMemberDto,
  type CategoryView,
  type CreateCategoryDto,
  type CreateSpaceDto,
  type PageSummary,
  type Principal,
  type SpaceAccess,
  type SpaceKind,
  type SpaceListQueryDto,
  type SpaceMemberRole,
  type SpaceMemberView,
  type SpaceStatus,
  type SpaceStatusDto,
  type SpaceView,
  type UpdateMemberRoleDto,
  type UpdateSpaceDto,
} from '@workfluence/shared';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.module';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { pages, spaceCategories, spaceMembers, spaces, users, type SpaceRow, type UserRow } from '../db/schema';
import { toPageSummary } from '../pages/page-view';
import { UsersService } from '../users/users.service';

type SpaceMeta = {
  space: SpaceRow;
  categoryName: string | null;
  createdByUsername: string;
  memberCount: number;
  myRole: SpaceMemberRole | null;
};

export type SpaceContext = SpaceMeta & { access: SpaceAccess };

function toSpaceView(m: SpaceContext): SpaceView {
  const s = m.space;
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    kind: s.kind as SpaceKind,
    status: s.status as SpaceStatus,
    categoryId: s.categoryId,
    categoryName: m.categoryName,
    createdBy: s.createdBy,
    createdByUsername: m.createdByUsername,
    memberCount: m.memberCount,
    myRole: m.myRole,
    access: m.access,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CategoryView[]> {
    const rows = await this.db.select().from(spaceCategories).orderBy(asc(spaceCategories.name));
    return rows.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt.toISOString() }));
  }

  async create(dto: CreateCategoryDto, actor: SessionUser, ip: string): Promise<CategoryView> {
    const dup = await this.db.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, dto.name) });
    if (dup) throw new ConflictException(`카테고리 '${dto.name}'는 이미 있다`);
    const [row] = await this.db.insert(spaceCategories).values({ name: dto.name, createdBy: actor.id }).returning();
    await this.audit.record({ action: 'category.create', actorId: actor.id, targetType: 'category', targetId: row.id, detail: { name: row.name }, ip });
    return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
  }
}

/**
 * 스페이스 (prototype-v2 2절 7·8·10·11번).
 * - 접근 판정은 shared.spaceAccess 한 곳. 여기서는 데이터를 모아 넘기고 결과로 403/404를 낸다.
 * - 생성자는 Crew owner. 개인 스페이스는 Crew를 두지 않는다.
 */
@Injectable()
export class SpacesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly users: UsersService,
  ) {}

  private memberCountSql = sql<number>`(select count(*)::int from ${spaceMembers} m where m.space_id = ${spaces.id})`;

  private async loadMany(where: SQL | undefined, principal: Principal, limit: number): Promise<SpaceContext[]> {
    const rows = await this.db
      .select({
        space: spaces,
        categoryName: spaceCategories.name,
        createdByUsername: users.username,
        memberCount: this.memberCountSql,
        myRole: spaceMembers.role,
      })
      .from(spaces)
      .innerJoin(users, eq(users.id, spaces.createdBy))
      .leftJoin(spaceCategories, eq(spaceCategories.id, spaces.categoryId))
      .leftJoin(spaceMembers, and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, principal.id)))
      .where(and(isNull(spaces.deletedAt), where))
      .orderBy(desc(spaces.updatedAt))
      .limit(limit);
    return rows.map((r) => {
      const meta: SpaceMeta = {
        space: r.space,
        categoryName: r.categoryName,
        createdByUsername: r.createdByUsername,
        memberCount: Number(r.memberCount),
        myRole: (r.myRole as SpaceMemberRole | null) ?? null,
      };
      const space = { kind: r.space.kind as SpaceKind, status: r.space.status as SpaceStatus, createdBy: r.space.createdBy };
      return { ...meta, access: spaceAccess(principal, space, meta.myRole, meta.memberCount) };
    });
  }

  async list(principal: Principal, q: SpaceListQueryDto): Promise<SpaceView[]> {
    const admin = can(principal, 'space.manage');
    let where: SQL | undefined;
    if (q.scope === 'personal') {
      where = and(eq(spaces.kind, 'personal'), eq(spaces.createdBy, principal.id));
    } else if (q.scope === 'team') {
      where = admin
        ? eq(spaces.kind, 'team')
        : and(eq(spaces.kind, 'team'), sql`exists (select 1 from ${spaceMembers} m where m.space_id = ${spaces.id} and m.user_id = ${principal.id})`);
    } else {
      if (!admin) throw new ForbiddenException('전체 스페이스 조회 권한이 없다');
      where = undefined;
    }
    const rows = await this.loadMany(where, principal, q.limit);
    return rows.filter((r) => r.access.canRead).map(toSpaceView);
  }

  /** 접근 판정까지 마친 스페이스 컨텍스트. 없으면 404, 읽을 수 없으면 403 */
  async context(id: string, principal: Principal): Promise<SpaceContext> {
    const [row] = await this.loadMany(eq(spaces.id, id), principal, 1);
    if (!row) throw new NotFoundException('스페이스를 찾을 수 없다');
    if (!row.access.canRead) throw new ForbiddenException('이 스페이스를 볼 권한이 없다');
    return row;
  }

  async assertWrite(id: string, principal: Principal): Promise<SpaceContext> {
    const ctx = await this.context(id, principal);
    if (!ctx.access.canWrite) {
      throw new ForbiddenException(ctx.space.status === 'suspended' ? '중지된 스페이스는 편집할 수 없다' : '이 스페이스를 편집할 권한이 없다');
    }
    return ctx;
  }

  async get(id: string, principal: Principal): Promise<SpaceView> {
    return toSpaceView(await this.context(id, principal));
  }

  private async uniqueKey(tx: Db): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const key = generateSpaceKey((max) => randomInt(max));
      const dup = await tx.query.spaces.findFirst({ where: eq(spaces.key, key) });
      if (!dup) return key;
    }
    throw new ConflictException('스페이스 식별자 생성에 실패했다. 다시 시도한다');
  }

  async create(dto: CreateSpaceDto, actor: SessionUser, ip: string): Promise<SpaceView> {
    if (dto.categoryId) {
      const cat = await this.db.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, dto.categoryId) });
      if (!cat) throw new NotFoundException('카테고리를 찾을 수 없다');
    }
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(spaces)
        .values({ key: await this.uniqueKey(tx), name: dto.name, description: dto.description, kind: dto.kind, categoryId: dto.categoryId, createdBy: actor.id })
        .returning();
      await tx.insert(spaceMembers).values({ spaceId: row.id, userId: actor.id, role: 'owner', addedBy: actor.id });
      await this.audit.record({ action: 'space.create', actorId: actor.id, targetType: 'space', targetId: row.id, detail: { name: row.name, kind: row.kind }, ip }, tx);
      return row.id;
    });
    return this.get(id, actor);
  }

  /** 승인·생성 시 개인 스페이스가 없으면 하나 만든다 (prototype-v2 2절 2번) */
  async ensurePersonalSpace(user: UserRow): Promise<void> {
    const existing = await this.db.query.spaces.findFirst({
      where: and(eq(spaces.kind, 'personal'), eq(spaces.createdBy, user.id), isNull(spaces.deletedAt)),
    });
    if (existing) return;
    const general = await this.db.query.spaceCategories.findFirst({ where: eq(spaceCategories.name, '일반') });
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(spaces)
        .values({
          key: await this.uniqueKey(tx),
          name: `${user.displayName}의 개인 스페이스`,
          description: '가입 승인 시 자동으로 만들어진 개인 공간',
          kind: 'personal',
          categoryId: general?.id ?? null,
          createdBy: user.id,
        })
        .returning();
      await tx.insert(spaceMembers).values({ spaceId: row.id, userId: user.id, role: 'owner', addedBy: user.id });
      await this.audit.record({ action: 'space.create', actorId: user.id, targetType: 'space', targetId: row.id, detail: { name: row.name, kind: 'personal', auto: true } }, tx);
    });
  }

  async update(id: string, dto: UpdateSpaceDto, actor: SessionUser, ip: string): Promise<SpaceView> {
    const ctx = await this.context(id, actor);
    if (!ctx.access.canChangeStatus) throw new ForbiddenException('스페이스 정보를 바꿀 권한이 없다');
    if (dto.categoryId) {
      const cat = await this.db.query.spaceCategories.findFirst({ where: eq(spaceCategories.id, dto.categoryId) });
      if (!cat) throw new NotFoundException('카테고리를 찾을 수 없다');
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(spaces)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(spaces.id, id));
      await this.audit.record({ action: 'space.update', actorId: actor.id, targetType: 'space', targetId: id, detail: dto, ip }, tx);
    });
    return this.get(id, actor);
  }

  async setStatus(id: string, dto: SpaceStatusDto, actor: SessionUser, ip: string): Promise<SpaceView> {
    const ctx = await this.context(id, actor);
    if (!ctx.access.canChangeStatus) throw new ForbiddenException('상태를 바꿀 권한이 없다');
    if (ctx.space.status === dto.status) return toSpaceView(ctx);
    await this.db.transaction(async (tx) => {
      await tx
        .update(spaces)
        .set({
          status: dto.status,
          suspendedAt: dto.status === 'suspended' ? sql`now()` : null,
          suspendedBy: dto.status === 'suspended' ? actor.id : null,
          updatedAt: sql`now()`,
        })
        .where(eq(spaces.id, id));
      await this.audit.record(
        { action: 'space.status.change', actorId: actor.id, targetType: 'space', targetId: id, detail: { from: ctx.space.status, to: dto.status }, ip },
        tx,
      );
    });
    return this.get(id, actor);
  }

  async remove(id: string, actor: SessionUser, ip: string): Promise<void> {
    const ctx = await this.context(id, actor);
    if (!ctx.access.canDelete) {
      const reason = ctx.access.isOwner
        ? 'Crew가 2명 이상인 스페이스는 생성자가 삭제할 수 없다. 먼저 중지하면 관리자가 삭제할 수 있다'
        : ctx.space.status === 'active'
          ? '활성 상태의 스페이스는 삭제할 수 없다. 먼저 중지한다'
          : '삭제 권한이 없다';
      throw new ForbiddenException(reason);
    }
    await this.db.transaction(async (tx) => {
      await tx.update(spaces).set({ deletedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(spaces.id, id));
      await this.audit.record({ action: 'space.delete', actorId: actor.id, targetType: 'space', targetId: id, detail: { name: ctx.space.name }, ip }, tx);
    });
  }

  async members(id: string, principal: Principal): Promise<SpaceMemberView[]> {
    await this.context(id, principal);
    const rows = await this.db
      .select({ userId: spaceMembers.userId, username: users.username, displayName: users.displayName, role: spaceMembers.role, createdAt: spaceMembers.createdAt })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(eq(spaceMembers.spaceId, id))
      .orderBy(asc(spaceMembers.createdAt));
    return rows.map((r) => ({ ...r, role: r.role as SpaceMemberRole, createdAt: r.createdAt.toISOString() }));
  }

  async addMember(id: string, dto: AddMemberDto, actor: SessionUser, ip: string): Promise<SpaceMemberView[]> {
    const ctx = await this.context(id, actor);
    if (ctx.space.kind !== 'team') throw new BadRequestException('개인 스페이스에는 Crew를 둘 수 없다');
    if (!ctx.access.canManageMembers) throw new ForbiddenException('Crew를 관리할 권한이 없다');
    const target = await this.users.findByUsername(dto.username);
    if (!target || target.status !== 'active') throw new NotFoundException('활성 사용자 중에 그 ID가 없다');
    const dup = await this.db.query.spaceMembers.findFirst({ where: and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, target.id)) });
    if (dup) throw new ConflictException('이미 Crew에 있다');
    await this.db.transaction(async (tx) => {
      await tx.insert(spaceMembers).values({ spaceId: id, userId: target.id, role: dto.role, addedBy: actor.id });
      await this.audit.record({ action: 'space.member.add', actorId: actor.id, targetType: 'space', targetId: id, detail: { username: target.username, role: dto.role }, ip }, tx);
    });
    return this.members(id, actor);
  }

  async updateMemberRole(id: string, userId: string, dto: UpdateMemberRoleDto, actor: SessionUser, ip: string): Promise<SpaceMemberView[]> {
    const ctx = await this.context(id, actor);
    if (!ctx.access.canManageMembers) throw new ForbiddenException('Crew를 관리할 권한이 없다');
    const row = await this.db.query.spaceMembers.findFirst({ where: and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, userId)) });
    if (!row) throw new NotFoundException('Crew에 없는 사용자');
    if (row.role === 'owner') throw new BadRequestException('생성자(owner)의 역할은 바꿀 수 없다');
    await this.db.transaction(async (tx) => {
      await tx.update(spaceMembers).set({ role: dto.role }).where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, userId)));
      await this.audit.record({ action: 'space.member.role.change', actorId: actor.id, targetType: 'space', targetId: id, detail: { userId, from: row.role, to: dto.role }, ip }, tx);
    });
    return this.members(id, actor);
  }

  async removeMember(id: string, userId: string, actor: SessionUser, ip: string): Promise<SpaceMemberView[]> {
    const ctx = await this.context(id, actor);
    if (!ctx.access.canManageMembers) throw new ForbiddenException('Crew를 관리할 권한이 없다');
    const row = await this.db.query.spaceMembers.findFirst({ where: and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, userId)) });
    if (!row) throw new NotFoundException('Crew에 없는 사용자');
    if (row.role === 'owner') throw new BadRequestException('생성자(owner)는 Crew에서 뺄 수 없다');
    await this.db.transaction(async (tx) => {
      await tx.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, userId)));
      await this.audit.record({ action: 'space.member.remove', actorId: actor.id, targetType: 'space', targetId: id, detail: { userId, role: row.role }, ip }, tx);
    });
    return this.members(id, actor);
  }

  /** 스페이스의 페이지 트리(평면 목록). 클라이언트가 parentId로 트리를 만든다. */
  async pageTree(spaceId: string, principal: Principal): Promise<PageSummary[]> {
    await this.context(spaceId, principal);
    const rows = await this.db
      .select()
      .from(pages)
      .where(and(eq(pages.spaceId, spaceId), isNull(pages.deletedAt)))
      .orderBy(asc(pages.position), asc(pages.createdAt));
    return rows.map(toPageSummary);
  }
}

@Controller('api/categories')
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(private readonly svc: CategoriesService) {}

  @Get()
  @RequireAction('page.read')
  list(): Promise<CategoryView[]> {
    return this.svc.list();
  }

  @Post()
  @RequireAction('category.create')
  create(@Body(new ZodPipe(createCategoryDto)) dto: CreateCategoryDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<CategoryView> {
    return this.svc.create(dto, actor, ip);
  }
}

@Controller('api/spaces')
@UseGuards(AuthGuard)
export class SpacesController {
  constructor(private readonly svc: SpacesService) {}

  @Get()
  @RequireAction('page.read')
  list(@Query(new ZodPipe(spaceListQueryDto)) q: SpaceListQueryDto, @CurrentUser() me: SessionUser): Promise<SpaceView[]> {
    return this.svc.list(me, q);
  }

  @Post()
  @RequireAction('space.create')
  create(@Body(new ZodPipe(createSpaceDto)) dto: CreateSpaceDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<SpaceView> {
    return this.svc.create(dto, actor, ip);
  }

  @Get(':id')
  @RequireAction('page.read')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: SessionUser): Promise<SpaceView> {
    return this.svc.get(id, me);
  }

  @Patch(':id')
  @RequireAction('page.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateSpaceDto)) dto: UpdateSpaceDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<SpaceView> {
    return this.svc.update(id, dto, actor, ip);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequireAction('page.write')
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(spaceStatusDto)) dto: SpaceStatusDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<SpaceView> {
    return this.svc.setStatus(id, dto, actor, ip);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAction('page.write')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<void> {
    return this.svc.remove(id, actor, ip);
  }

  @Get(':id/pages')
  @RequireAction('page.read')
  tree(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: SessionUser): Promise<PageSummary[]> {
    return this.svc.pageTree(id, me);
  }

  @Get(':id/members')
  @RequireAction('page.read')
  members(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: SessionUser): Promise<SpaceMemberView[]> {
    return this.svc.members(id, me);
  }

  @Post(':id/members')
  @RequireAction('page.write')
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(addMemberDto)) dto: AddMemberDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<SpaceMemberView[]> {
    return this.svc.addMember(id, dto, actor, ip);
  }

  @Patch(':id/members/:userId')
  @RequireAction('page.write')
  updateMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodPipe(updateMemberRoleDto)) dto: UpdateMemberRoleDto,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<SpaceMemberView[]> {
    return this.svc.updateMemberRole(id, userId, dto, actor, ip);
  }

  @Delete(':id/members/:userId')
  @RequireAction('page.write')
  removeMember(@Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<SpaceMemberView[]> {
    return this.svc.removeMember(id, userId, actor, ip);
  }
}

@Module({
  controllers: [SpacesController, CategoriesController],
  providers: [SpacesService, CategoriesService],
  exports: [SpacesService, CategoriesService],
})
export class SpacesModule {}
