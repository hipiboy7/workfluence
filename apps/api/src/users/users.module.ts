import { Body, Controller, Get, Global, Module, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  createUserDto,
  listUsersDto,
  updateUserRoleDto,
  userGrantsDto,
  type CreateUserDto,
  type ListUsersDto,
  type UpdateUserRoleDto,
  type UserGrantsDto,
  type UserListView,
  type UserView,
} from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { UserUseCases } from './users.usecases';
import { UsersService } from './users.service';

/** 사용자 관리 API (P1_설계서_Auth 5절). 쓰기의 트랜잭션·감사·끊는 통지의 순서는 `UserUseCases`에 있다 */
@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly uc: UserUseCases,
  ) {}

  @Get()
  @RequireAction('user.manage')
  list(@Query(new ZodPipe(listUsersDto)) q: ListUsersDto): Promise<UserListView> {
    return this.users.list(q);
  }

  @Post()
  @RequireAction('user.manage')
  create(@Body(new ZodPipe(createUserDto)) dto: CreateUserDto, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.uc.create(dto, actor, metaOf(req));
  }

  @Post(':id/approve')
  @RequireAction('user.manage')
  approve(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.uc.approve(id, actor, metaOf(req));
  }

  @Post(':id/unlock')
  @RequireAction('user.manage')
  unlock(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.uc.unlock(id, actor, metaOf(req));
  }

  @Post(':id/suspend')
  @RequireAction('user.manage')
  suspend(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.uc.suspend(id, actor, metaOf(req));
  }

  @Post(':id/unsuspend')
  @RequireAction('user.manage')
  unsuspend(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.uc.unsuspend(id, actor, metaOf(req));
  }

  @Post(':id/terminate-sessions')
  @RequireAction('user.manage')
  terminateSessions(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<{ count: number }> {
    return this.uc.terminateSessions(id, actor, metaOf(req));
  }

  @Post(':id/reset-password')
  @RequireAction('user.manage')
  resetPassword(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<{ user: UserView; temporaryPassword: string }> {
    return this.uc.resetPassword(id, actor, metaOf(req));
  }

  @Patch(':id/role')
  @RequireAction('user.role.change')
  changeRole(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateUserRoleDto)) dto: UpdateUserRoleDto,
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<UserView> {
    return this.uc.changeRole(id, dto.role, actor, metaOf(req));
  }

  @Put(':id/grants')
  @RequireAction('user.grants.change')
  changeGrants(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(userGrantsDto)) dto: UserGrantsDto,
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<UserView> {
    return this.uc.changeGrants(id, dto, actor, metaOf(req));
  }
}

/**
 * 전역 모듈. AuthGuard가 UsersService를 쓰는데, **가드의 의존성은 가드를 쓰는 컨트롤러의
 * 모듈에서 해석된다.** 전역이 아니면 가드를 쓰는 모든 모듈이 이것을 import해야 한다 (P0 13절 인계).
 */
@Global()
@Module({
  providers: [UsersService, UserUseCases],
  controllers: [UsersController],
  exports: [UsersService, UserUseCases],
})
export class UsersModule {}
