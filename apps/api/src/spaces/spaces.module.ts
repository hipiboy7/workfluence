import { Body, Controller, Delete, Get, Global, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  addMemberDto,
  createCategoryDto,
  createSpaceDto,
  spaceListQueryDto,
  spaceStatusDto,
  updateMemberRoleDto,
  updateSpaceDto,
  type AddMemberDto,
  type CategoryView,
  type CreateCategoryDto,
  type CreateSpaceDto,
  type SpaceListQueryDto,
  type SpaceMemberView,
  type SpaceStatusDto,
  type SpaceView,
  type UpdateMemberRoleDto,
  type UpdateSpaceDto,
} from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CategoryUseCases } from './categories.usecases';
import { SpacesService } from './spaces.service';
import { SpaceUseCases } from './spaces.usecases';

/** 스페이스 API (P2_설계서_Page 2절). 쓰기의 트랜잭션·감사는 `SpaceUseCases`에 있다 */
@Controller('api/spaces')
@UseGuards(AuthGuard)
export class SpacesController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly uc: SpaceUseCases,
  ) {}

  @Get()
  list(@Query(new ZodPipe(spaceListQueryDto)) q: SpaceListQueryDto, @CurrentUser() me: SessionUser): Promise<SpaceView[]> {
    return this.spaces.list(me, q.scope, q.limit, { q: q.q, status: q.status });
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<SpaceView> {
    return this.spaces.get(id, me);
  }

  @Post()
  @RequireAction('space.create')
  create(@Body(new ZodPipe(createSpaceDto)) dto: CreateSpaceDto, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<SpaceView> {
    return this.uc.create(dto, me, metaOf(req));
  }

  @Patch(':id')
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateSpaceDto)) dto: UpdateSpaceDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceView> {
    return this.uc.update(id, dto, me, metaOf(req));
  }

  @Patch(':id/status')
  changeStatus(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(spaceStatusDto)) dto: SpaceStatusDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceView> {
    return this.uc.changeStatus(id, dto, me, metaOf(req));
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    return this.uc.remove(id, me, metaOf(req));
  }

  // ---- Crew ----

  @Get(':id/members')
  members(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<SpaceMemberView[]> {
    return this.spaces.members(id, me);
  }

  @Post(':id/members')
  addMember(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(addMemberDto)) dto: AddMemberDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceMemberView[]> {
    return this.uc.addMember(id, dto, me, metaOf(req));
  }

  @Patch(':id/members/:userId')
  changeMemberRole(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @Body(new ZodPipe(updateMemberRoleDto)) dto: UpdateMemberRoleDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceMemberView[]> {
    return this.uc.changeMemberRole(id, userId, dto.role, me, metaOf(req));
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', UuidPipe) id: string,
    @Param('userId', UuidPipe) userId: string,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<SpaceMemberView[]> {
    return this.uc.removeMember(id, userId, me, metaOf(req));
  }
}

/** 분류 (FR-308 · P15 D.4). 가드는 로그인만 본다 — 이름 바꾸기·지우기의 판정·잠금은 `CategoryUseCases`에 있다 */
@Controller('api/categories')
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(private readonly uc: CategoryUseCases) {}

  @Get()
  list(@CurrentUser() me: SessionUser): Promise<CategoryView[]> {
    return this.uc.list(me);
  }

  @Patch(':id')
  rename(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(createCategoryDto)) dto: CreateCategoryDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CategoryView> {
    return this.uc.rename(id, dto, me, metaOf(req));
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    return this.uc.remove(id, me, metaOf(req));
  }

  @Post()
  @RequireAction('category.create')
  create(@Body(new ZodPipe(createCategoryDto)) dto: CreateCategoryDto, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<CategoryView> {
    return this.uc.create(dto, me, metaOf(req));
  }
}

/** 전역: PagesService와 UsersService(개인 스페이스 자동 생성)가 SpacesService를 쓴다 */
@Global()
@Module({
  providers: [SpacesService, SpaceUseCases, CategoryUseCases],
  controllers: [SpacesController, CategoriesController],
  exports: [SpacesService],
})
export class SpacesModule {}
