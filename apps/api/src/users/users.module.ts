import { Body, Controller, Get, Global, Inject, Module, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { createUserDto, updateUserRoleDto, userGrantsDto, type UserGrantsDto, type UserView, listUsersDto, type ListUsersDto, type UserListView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { RevocationBus } from '../common/revocation.bus';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { NotificationsService } from '../notifications/notifications.service';
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
    private readonly revocation: RevocationBus,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @RequireAction('user.manage')
  list(@Query(new ZodPipe(listUsersDto)) q: ListUsersDto): Promise<UserListView> {
    return this.users.list(q);
  }

  @Post()
  @RequireAction('user.manage')
  async create(
    @Body(new ZodPipe(createUserDto)) dto: ReturnType<typeof createUserDto.parse>,
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<UserView> {
    // 해시는 트랜잭션을 열기 전에 (P13 FR-1434)
    const passwordHash = await this.users.preparePassword(dto.password);
    return this.db.transaction(async (tx) => {
      const row = await this.users.create(dto, actor, tx, passwordHash);
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
  async approve(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
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
  async unlock(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.unlock(id, actor, tx);
      await this.audit.record({ action: 'user.unlock', actorId: actor.id, targetType: 'user', targetId: id, ip: req.ip }, tx);
      return toUserView(row);
    });
  }

  /** 정지 (P13 FR-1441~1444) — 세션을 모두 끊고, 열린 편집 연결을 그 자리에서 끊는다 */
  @Post(':id/suspend')
  @RequireAction('user.manage')
  async suspend(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    const view = await this.db.transaction(async (tx) => {
      const { row, before } = await this.users.suspend(id, actor, tx);
      await this.audit.record(
        { action: 'user.suspend', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username, before }, ip: req.ip },
        tx,
      );
      return toUserView(row);
    });
    // **끊는 알림은 커밋한 뒤에** (P13 D.5, 병합 전 검토) — 먼저 울리면 커밋 전 몇 ms 사이에 다시 붙은 연결이 옛 상태(활성)를 읽고 주기
    // 재판정까지 살아남고, 커밋이 실패하면 정지는 안 됐는데 연결만 끊긴다
    this.revocation.revoke(id);
    return view;
  }

  /** 정지 해제 (P13 FR-1441·1444) */
  @Post(':id/unsuspend')
  @RequireAction('user.manage')
  async unsuspend(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.unsuspend(id, actor, tx);
      await this.audit.record({ action: 'user.unsuspend', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username }, ip: req.ip }, tx);
      return toUserView(row);
    });
  }

  /** 관리자 강제 종료 (FR-539). 지금 열려 있는 세션을 전부 끊는다 */
  @Post(':id/terminate-sessions')
  @RequireAction('user.manage')
  async terminateSessions(@Param('id', UuidPipe) id: string, @CurrentUser() actor: SessionUser, @Req() req: Request): Promise<{ count: number }> {
    const result = await this.db.transaction(async (tx) => {
      const count = await this.users.terminateSessions(id, actor, tx);
      await this.audit.record(
        { action: 'user.sessions.terminate', actorId: actor.id, targetType: 'user', targetId: id, detail: { count }, ip: req.ip },
        tx,
      );
      return { count };
    });
    // 끊는 알림은 커밋한 뒤에 — 정지와 같다
    this.revocation.revoke(id);
    return result;
  }

  /** 임시 비밀번호는 **이 응답에 한 번만** 실린다. 저장하지 않고 감사로그에도 남기지 않는다 (FR-209, FR-238) */
  @Post(':id/reset-password')
  @RequireAction('user.manage')
  async resetPassword(
    @Param('id', UuidPipe) id: string,
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<{ user: UserView; temporaryPassword: string }> {
    // 임시 비밀번호의 해시는 트랜잭션을 열기 전에 (P13 FR-1434)
    const prepared = await this.users.prepareTemporaryPassword();
    const result = await this.db.transaction(async (tx) => {
      const { user, temporaryPassword } = await this.users.resetPassword(id, actor, tx, prepared);
      await this.audit.record({ action: 'user.password.reset', actorId: actor.id, targetType: 'user', targetId: id, ip: req.ip }, tx);
      // 그 사람이 비밀번호 찾기로 남긴 요청은 처리됐다 — 받은 관리자 모두의 알림함에서 읽음이 된다 (P17 FR-1803)
      await this.notifications.resolveRecoveryRequests(id, tx);
      return { user: toUserView(user), temporaryPassword };
    });
    // 끊는 알림은 커밋한 뒤에 — 정지와 같다 (좁은 자체 점검 5)
    this.revocation.revoke(id);
    return result;
  }

  @Patch(':id/role')
  @RequireAction('user.role.change')
  async changeRole(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateUserRoleDto)) dto: { role: ReturnType<typeof updateUserRoleDto.parse>['role'] },
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const { row, clearedGrants } = await this.users.changeRole(id, dto.role, actor, tx);
      // 관리자가 아니게 되어 위임이 사라졌으면 같은 행에 남긴다 (P11 FR-1205)
      const detail = { role: dto.role, ...(clearedGrants.length ? { clearedGrants } : {}) };
      await this.audit.record({ action: 'user.role.change', actorId: actor.id, targetType: 'user', targetId: id, detail, ip: req.ip }, tx);
      return toUserView(row);
    });
  }

  /**
   * 위임을 주고 거둔다 (P11_설계서_Ops D.1·F절 · P15_설계서_Grants D.1·F절). 창구는 root와 관리자 — 무엇을 줄 수 있는지는 서비스가 규칙표로 본다.
   * 목록 전체를 받고, 화면이 본 목록(`expected`)이 서버의 것과 다르면 409다
   */
  @Put(':id/grants')
  @RequireAction('user.grants.change')
  async changeGrants(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(userGrantsDto)) dto: UserGrantsDto,
    @CurrentUser() actor: SessionUser,
    @Req() req: Request,
  ): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const { row, before, after, changed } = await this.users.changeGrants(id, dto.grants, actor, tx, dto.expected);
      // 바뀐 것이 없으면 남기지 않는다 — 같은 목록을 다시 보낸 것은 권한 변경이 아니다 (P11 코드 리뷰 9)
      if (changed) {
        await this.audit.record(
          { action: 'user.grants.change', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username, before, after }, ip: req.ip },
          tx,
        );
      }
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
