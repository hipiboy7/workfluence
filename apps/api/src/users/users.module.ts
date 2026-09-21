import { Body, Controller, Get, Global, Inject, Module, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createUserDto, listLimitDto, updateUserRoleDto, type UserView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.module';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { UsersService, toUserView } from './users.service';

/** 사용자 관리 API (P1_설계서_Auth 5절). 모든 쓰기는 감사로그와 **같은 트랜잭션**이다 (FR-236). */
@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
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
