import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  matchMember,
  matchSpaces,
  toV1Category,
  toV1Member,
  toV1Space,
  v1AddMemberDto,
  v1CategoryDto,
  v1CreateSpaceDto,
  v1MemberRoleDto,
  v1SpaceListQuery,
  v1SpaceStatusDto,
  v1UpdateSpaceDto,
  V1_DEFAULTS,
  type UpdateSpaceDto,
  type V1CategoryView,
  type V1MemberView,
  type V1SpaceListQuery,
  type V1SpaceView,
} from '@workfluence/shared';
import type { Request } from 'express';
import { CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CategoryUseCases } from '../spaces/categories.usecases';
import { SpacesService } from '../spaces/spaces.service';
import { SpaceUseCases } from '../spaces/spaces.usecases';
import { readableSpaces } from './space-ref';
import { UseV1 } from './use-v1';

/**
 * 공개 API v1 — 스페이스·Crew (docs/spinoff/public-api 설계서 3.3·3.5절). 얇은 층이다(FR-2210) — 트랜잭션·감사는 화면용과 같은 `SpaceUseCases`가 한다.
 * 에이전트용 단순 계약: 이름만으로 팀 스페이스를 만들고, 분류는 이름으로 고르고, Crew는 사용자 이름으로 다룬다(기본 역할 editor).
 */
@Controller('api/v1/spaces')
@UseV1()
export class V1SpacesController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly uc: SpaceUseCases,
    private readonly categories: CategoryUseCases,
  ) {}

  /** 분류를 이름으로 — 없으면 고를 수 있는 이름을 알려 준다 */
  private async categoryId(name: string, me: SessionUser): Promise<string> {
    const all = await this.categories.list(me);
    const found = matchSpaces(name, all);
    if (found.length === 0) {
      throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: '분류를 찾을 수 없다 — available에서 고른다', details: { available: all.map((c) => c.name) } });
    }
    return found[0]!.id;
  }

  /** Crew를 사용자 이름이나 id로 */
  private async memberId(spaceId: string, ref: string, me: SessionUser): Promise<string> {
    const m = matchMember(ref, await this.spaces.members(spaceId, me));
    if (!m) throw new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: '이 스페이스의 Crew에 없는 사람이다' });
    return m.userId;
  }

  @Get()
  async list(@Query(new ZodPipe(v1SpaceListQuery)) q: V1SpaceListQuery, @CurrentUser() me: SessionUser): Promise<{ items: V1SpaceView[] }> {
    const limit = q.limit ?? V1_DEFAULTS.listLimit;
    return { items: (await readableSpaces(this.spaces, me, { q: q.q }, limit)).slice(0, limit).map(toV1Space) };
  }

  @Get(':id')
  async get(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<V1SpaceView> {
    return toV1Space(await this.spaces.get(id, me));
  }

  @Post()
  @RequireAction('space.create')
  async create(
    @Body(new ZodPipe(v1CreateSpaceDto)) dto: ReturnType<typeof v1CreateSpaceDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1SpaceView> {
    const categoryId = dto.category === null ? null : await this.categoryId(dto.category, me);
    return toV1Space(await this.uc.create({ name: dto.name, kind: V1_DEFAULTS.spaceKind, categoryId, description: dto.description }, me, metaOf(req)));
  }

  @Patch(':id')
  async update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1UpdateSpaceDto)) dto: ReturnType<typeof v1UpdateSpaceDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1SpaceView> {
    const patch: UpdateSpaceDto = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.category !== undefined) patch.categoryId = dto.category === null ? null : await this.categoryId(dto.category, me);
    return toV1Space(await this.uc.update(id, patch, me, metaOf(req)));
  }

  @Patch(':id/status')
  async changeStatus(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1SpaceStatusDto)) dto: ReturnType<typeof v1SpaceStatusDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1SpaceView> {
    return toV1Space(await this.uc.changeStatus(id, dto, me, metaOf(req)));
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    return this.uc.remove(id, me, metaOf(req));
  }

  // ---- Crew ----

  @Get(':id/members')
  async members(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<V1MemberView[]> {
    return (await this.spaces.members(id, me)).map(toV1Member);
  }

  @Post(':id/members')
  async addMember(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1AddMemberDto)) dto: ReturnType<typeof v1AddMemberDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1MemberView[]> {
    return (await this.uc.addMember(id, dto, me, metaOf(req))).map(toV1Member);
  }

  @Patch(':id/members/:ref')
  async changeMemberRole(
    @Param('id', UuidPipe) id: string,
    @Param('ref') ref: string,
    @Body(new ZodPipe(v1MemberRoleDto)) dto: ReturnType<typeof v1MemberRoleDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1MemberView[]> {
    return (await this.uc.changeMemberRole(id, await this.memberId(id, ref, me), dto.role, me, metaOf(req))).map(toV1Member);
  }

  @Delete(':id/members/:ref')
  async removeMember(@Param('id', UuidPipe) id: string, @Param('ref') ref: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<V1MemberView[]> {
    return (await this.uc.removeMember(id, await this.memberId(id, ref, me), me, metaOf(req))).map(toV1Member);
  }
}

/** 공개 API v1 — 분류. 이름만 다룬다 (설계서 3.5절) */
@Controller('api/v1/categories')
@UseV1()
export class V1CategoriesController {
  constructor(private readonly uc: CategoryUseCases) {}

  @Get()
  async list(@CurrentUser() me: SessionUser): Promise<V1CategoryView[]> {
    return (await this.uc.list(me)).map(toV1Category);
  }

  /** 같은 이름이면 있던 것을 돌려준다(멱등) */
  @Post()
  @RequireAction('category.create')
  async create(@Body(new ZodPipe(v1CategoryDto)) dto: ReturnType<typeof v1CategoryDto.parse>, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<V1CategoryView> {
    return toV1Category(await this.uc.create(dto, me, metaOf(req)));
  }

  @Patch(':id')
  async rename(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1CategoryDto)) dto: ReturnType<typeof v1CategoryDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1CategoryView> {
    return toV1Category(await this.uc.rename(id, dto, me, metaOf(req)));
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    return this.uc.remove(id, me, metaOf(req));
  }
}
