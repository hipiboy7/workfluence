import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  auditQueryDto,
  createUserDto,
  listUsersDto,
  policyPatchDto,
  updateUserRoleDto,
  userGrantsDto,
  type AuditEventView,
  type AuditQueryDto,
  type CreateUserDto,
  type ListUsersDto,
  type PolicyPatchDto,
  type UpdateUserRoleDto,
  type UserGrantsDto,
  type UserListView,
  type UserView,
} from '@workfluence/shared';
import type { Request } from 'express';
import { ApiAdminRoute } from '../api-tokens/api-token.guard';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { PolicyUseCases, type PolicyRead } from '../settings/policy.usecases';
import { UsersService } from '../users/users.service';
import { UserUseCases } from '../users/users.usecases';
import { UseV1 } from './use-v1';

/**
 * 공개 API v1 — 사용자 관리 (docs/spinoff/public-api 설계서 3.3절). 얇은 층이다(FR-2210) — 판정(`user.manage`·대상이 가진 위임)과 트랜잭션·감사·끊는 통지는
 * 화면용과 같은 `UserUseCases`가 한다. **모든 경로에 `admin` scope가 더 필요하다**(Q4). **비밀번호 초기화는 열지 않는다**(FR-2209) — 임시 비밀번호를
 * 응답으로 돌려주는 경로가 토큰에 있으면 토큰 하나가 남의 계정을 넘겨받는 길이 된다
 */
@Controller('api/v1/users')
@UseV1()
@ApiAdminRoute()
export class V1UsersController {
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

/** 공개 API v1 — 운영 정책값. 읽기는 `settings.manage`가 있으면 전부, 고치기는 같은 유스케이스(감사 단계는 root만) */
@Controller('api/v1/settings/policy')
@UseV1()
@ApiAdminRoute()
export class V1PolicyController {
  constructor(private readonly uc: PolicyUseCases) {}

  @Get()
  get(@CurrentUser() me: SessionUser): Promise<PolicyRead> {
    return this.uc.read(me);
  }

  @Patch()
  @RequireAction('settings.manage')
  async update(@Body(new ZodPipe(policyPatchDto)) patch: PolicyPatchDto, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.update(patch, me, metaOf(req));
    return { ok: true };
  }
}

/** 공개 API v1 — 감사로그 읽기. 쓰는 경로는 없다(append-only). 다른 v1 목록처럼 `{items}`로 싼다(화면용은 배열) */
@Controller('api/v1/audit')
@UseV1()
@ApiAdminRoute()
export class V1AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireAction('audit.read')
  async list(@Query(new ZodPipe(auditQueryDto)) q: AuditQueryDto): Promise<{ items: AuditEventView[] }> {
    return { items: await this.audit.list(q) };
  }
}
