import { Body, Controller, Get, Global, Inject, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createUserDto, listLimitDto, updateUserRoleDto, type UserView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { SpacesService } from '../spaces/spaces.service';
import { UsersService, toUserView } from './users.service';

/** 사용자 관리 API (P1_설계서_Auth 5절). 모든 쓰기는 감사로그와 **같은 트랜잭션**이다 (FR-236). */
@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly spaces: SpacesService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  @RequireAction('user.manage')
  list(@Query(new ZodPipe(listLimitDto)) q: { limit: number }): Promise<UserView[]> {
    return this.users.list(q.limit);
  }

  @Post()
  @RequireAction('user.manage')
  async create(
    @Body(new ZodPipe(createUserDto)) dto: ReturnType<typeof createUserDto.parse>,
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.create(dto, actor, tx);
      // 관리자가 만든 계정도 바로 활성이다. 승인 경로를 거치지 않으므로 여기서도 만든다 (FR-309)
      await this.spaces.ensurePersonalSpace(row.id, row.displayName, tx);
      await this.audit.record(
        { action: 'user.create', actorId: actor.id, targetType: 'user', targetId: row.id, detail: { username: row.username, role: row.role }, ip: req.ip },
        tx,
      );
      return toUserView(row);
    });
  }

  @Post(':id/approve')
  @RequireAction('user.manage')
  async approve(@Param('id') id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.approve(id, actor, tx);
      // **승인과 같은 트랜잭션에서** 개인 스페이스를 만든다 (FR-309).
      // 따로 두면 승인은 됐는데 스페이스가 없는 계정이 생긴다
      await this.spaces.ensurePersonalSpace(row.id, row.displayName, tx);
      await this.audit.record({ action: 'user.approve', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username }, ip: req.ip }, tx);
      return toUserView(row);
    });
  }

  @Post(':id/unlock')
  @RequireAction('user.manage')
  async unlock(@Param('id') id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.unlock(id, actor, tx);
      await this.audit.record({ action: 'user.unlock', actorId: actor.id, targetType: 'user', targetId: id, ip: req.ip }, tx);
      return toUserView(row);
    });
  }

  /** 관리자 강제 종료 (FR-539). 지금 열려 있는 세션을 전부 끊는다 */
  @Post(':id/terminate-sessions')
  @RequireAction('user.manage')
  async terminateSessions(@Param('id') id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<{ count: number }> {
    return this.db.transaction(async (tx) => {
      const count = await this.users.terminateSessions(id, actor, tx);
      await this.audit.record(
        { action: 'user.sessions.terminate', actorId: actor.id, targetType: 'user', targetId: id, detail: { count }, ip: req.ip },
        tx,
      );
      return { count };
    });
  }

  /** 임시 비밀번호는 **이 응답에 한 번만** 실린다. 저장하지 않고 감사로그에도 남기지 않는다 (FR-209, FR-238) */
  @Post(':id/reset-password')
  @RequireAction('user.manage')
  async resetPassword(
    @Param('id') id: string,
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<{ user: UserView; temporaryPassword: string }> {
    return this.db.transaction(async (tx) => {
      const { user, temporaryPassword } = await this.users.resetPassword(id, actor, tx);
      await this.audit.record({ action: 'user.password.reset', actorId: actor.id, targetType: 'user', targetId: id, ip: req.ip }, tx);
      return { user: toUserView(user), temporaryPassword };
    });
  }

  @Patch(':id/role')
  @RequireAction('user.role.change')
  async changeRole(
    @Param('id') id: string,
    @Body(new ZodPipe(updateUserRoleDto)) dto: { role: ReturnType<typeof updateUserRoleDto.parse>['role'] },
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.changeRole(id, dto.role, actor, tx);
      await this.audit.record({ action: 'user.role.change', actorId: actor.id, targetType: 'user', targetId: id, detail: { role: dto.role }, ip: req.ip }, tx);
      return toUserView(row);
    });
  }
}

/**
 * 전역 모듈. AuthGuard가 UsersService를 쓰는데, **가드의 의존성은 가드를 쓰는 컨트롤러의
 * 모듈에서 해석된다.** 전역이 아니면 가드를 쓰는 모든 모듈이 이것을 import해야 한다 (P0 13절 인계).
 */
@Global()
@Module({
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
