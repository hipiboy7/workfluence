import {
  Body,
  ConflictException,
  Controller,
  Delete,
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
  UseGuards,
} from '@nestjs/common';
import {
  createSpaceDto,
  updateSpaceDto,
  type CreateSpaceDto,
  type PageSummary,
  type SpaceView,
  type UpdateSpaceDto,
} from '@workfluence/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { AuditModule, AuditService } from '../audit/audit.module';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { AuthModule } from '../auth/auth.module';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { pages, spaces, type SpaceRow } from '../db/schema';
import { toPageSummary } from '../pages/pages.service';

export function toSpaceView(s: SpaceRow): SpaceView {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    description: s.description,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class SpacesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<SpaceView[]> {
    const rows = await this.db.select().from(spaces).where(isNull(spaces.deletedAt)).orderBy(asc(spaces.key));
    return rows.map(toSpaceView);
  }

  async getOrThrow(id: string): Promise<SpaceRow> {
    const row = await this.db.query.spaces.findFirst({ where: and(eq(spaces.id, id), isNull(spaces.deletedAt)) });
    if (!row) throw new NotFoundException('스페이스를 찾을 수 없다');
    return row;
  }

  async create(dto: CreateSpaceDto, actor: SessionUser, ip: string): Promise<SpaceView> {
    return this.db.transaction(async (tx) => {
      const dup = await tx.query.spaces.findFirst({ where: eq(spaces.key, dto.key) });
      if (dup) throw new ConflictException(`스페이스 키 '${dto.key}'는 이미 사용 중이다`);
      const [row] = await tx
        .insert(spaces)
        .values({ key: dto.key, name: dto.name, description: dto.description, createdBy: actor.id })
        .returning();
      await this.audit.record({ action: 'space.create', actorId: actor.id, targetType: 'space', targetId: row.id, detail: { key: row.key }, ip }, tx);
      return toSpaceView(row);
    });
  }

  async update(id: string, dto: UpdateSpaceDto, actor: SessionUser, ip: string): Promise<SpaceView> {
    await this.getOrThrow(id);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(spaces)
        .set({ ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), updatedAt: sql`now()` })
        .where(eq(spaces.id, id))
        .returning();
      await this.audit.record({ action: 'space.update', actorId: actor.id, targetType: 'space', targetId: id, detail: dto, ip }, tx);
      return toSpaceView(row);
    });
  }

  async softDelete(id: string, actor: SessionUser, ip: string): Promise<void> {
    await this.getOrThrow(id);
    await this.db.transaction(async (tx) => {
      await tx.update(spaces).set({ deletedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(spaces.id, id));
      await this.audit.record({ action: 'space.delete', actorId: actor.id, targetType: 'space', targetId: id, ip }, tx);
    });
  }

  /** 스페이스의 페이지 트리(평면 목록). 클라이언트가 parentId로 트리를 만든다. */
  async pageTree(spaceId: string): Promise<PageSummary[]> {
    await this.getOrThrow(spaceId);
    const rows = await this.db
      .select()
      .from(pages)
      .where(and(eq(pages.spaceId, spaceId), isNull(pages.deletedAt)))
      .orderBy(asc(pages.position), asc(pages.createdAt));
    return rows.map(toPageSummary);
  }
}

@Controller('api/spaces')
@UseGuards(AuthGuard)
export class SpacesController {
  constructor(private readonly svc: SpacesService) {}

  @Get()
  @RequireAction('page.read')
  list(): Promise<SpaceView[]> {
    return this.svc.list();
  }

  @Post()
  @RequireAction('space.create')
  create(@Body(new ZodPipe(createSpaceDto)) dto: CreateSpaceDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<SpaceView> {
    return this.svc.create(dto, actor, ip);
  }

  @Get(':id')
  @RequireAction('page.read')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<SpaceView> {
    return toSpaceView(await this.svc.getOrThrow(id));
  }

  @Patch(':id')
  @RequireAction('space.edit')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSpaceDto)) dto: UpdateSpaceDto,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<SpaceView> {
    return this.svc.update(id, dto, actor, ip);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAction('space.delete')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<void> {
    return this.svc.softDelete(id, actor, ip);
  }

  @Get(':id/pages')
  @RequireAction('page.read')
  tree(@Param('id', ParseUUIDPipe) id: string): Promise<PageSummary[]> {
    return this.svc.pageTree(id);
  }
}

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [SpacesController],
  providers: [SpacesService],
  exports: [SpacesService],
})
export class SpacesModule {}
