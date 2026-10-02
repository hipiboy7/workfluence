import { Inject, Injectable } from '@nestjs/common';
import type { CreateUserDto, Role, UserGrantsDto, UserView } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { RevocationBus } from '../common/revocation.bus';
import { DB, type Db } from '../db/db.module';
import { NotificationsService } from '../notifications/notifications.service';
import { SpacesService } from '../spaces/spaces.service';
import { UsersService, toUserView } from './users.service';

/**
 * 사용자 관리 (P1_설계서_Auth 5절). 모든 쓰기는 감사로그와 **같은 트랜잭션**이다 (FR-236). 권한(`user.manage` 등)은 경로의 가드가,
 * 대상마다의 판정은 서비스가 본다. 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절). 목록은 서비스를 바로 부른다.
 *
 * **세션을 끊는 통지는 커밋한 뒤에** (P13 D.5, 병합 전 검토) — 먼저 울리면 커밋 전 몇 ms 사이에 다시 붙은 연결이 옛 상태(활성)를 읽고 주기
 * 재판정까지 살아남고, 커밋이 실패하면 정지는 안 됐는데 연결만 끊긴다. 공개 API 토큰도 이 통지로 끊긴다(분석서 G3)
 */
@Injectable()
export class UserUseCases {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly spaces: SpacesService,
    private readonly notifications: NotificationsService,
    private readonly revocation: RevocationBus,
    @Inject(DB) private readonly db: Db,
  ) {}

  async create(dto: CreateUserDto, actor: SessionUser, meta: RequestMeta): Promise<UserView> {
    // 해시는 트랜잭션을 열기 전에 (P13 FR-1434)
    const passwordHash = await this.users.preparePassword(dto.password);
    return this.db.transaction(async (tx) => {
      const row = await this.users.create(dto, actor, tx, passwordHash);
      // 관리자가 만든 계정도 바로 활성이다. 승인 경로를 거치지 않으므로 여기서도 만든다 (FR-309)
      await this.spaces.ensurePersonalSpace(row.id, row.displayName, tx);
      await this.audit.record(
        { action: 'user.create', actorId: actor.id, targetType: 'user', targetId: row.id, detail: { username: row.username, role: row.role }, ip: meta.ip },
        tx,
      );
      return toUserView(row);
    });
  }

  approve(id: string, actor: SessionUser, meta: RequestMeta): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.approve(id, actor, tx);
      // **승인과 같은 트랜잭션에서** 개인 스페이스를 만든다 (FR-309).
      // 따로 두면 승인은 됐는데 스페이스가 없는 계정이 생긴다
      await this.spaces.ensurePersonalSpace(row.id, row.displayName, tx);
      await this.audit.record({ action: 'user.approve', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username }, ip: meta.ip }, tx);
      return toUserView(row);
    });
  }

  unlock(id: string, actor: SessionUser, meta: RequestMeta): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.unlock(id, actor, tx);
      await this.audit.record({ action: 'user.unlock', actorId: actor.id, targetType: 'user', targetId: id, ip: meta.ip }, tx);
      return toUserView(row);
    });
  }

  /** 정지 (P13 FR-1441~1444) — 세션을 모두 끊고, 열린 편집 연결을 그 자리에서 끊는다 */
  async suspend(id: string, actor: SessionUser, meta: RequestMeta): Promise<UserView> {
    const view = await this.db.transaction(async (tx) => {
      const { row, before } = await this.users.suspend(id, actor, tx);
      await this.audit.record(
        { action: 'user.suspend', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username, before }, ip: meta.ip },
        tx,
      );
      return toUserView(row);
    });
    this.revocation.revoke(id);
    return view;
  }

  /** 정지 해제 (P13 FR-1441·1444) */
  unsuspend(id: string, actor: SessionUser, meta: RequestMeta): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const row = await this.users.unsuspend(id, actor, tx);
      await this.audit.record({ action: 'user.unsuspend', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username }, ip: meta.ip }, tx);
      return toUserView(row);
    });
  }

  /** 관리자 강제 종료 (FR-539). 지금 열려 있는 세션을 전부 끊는다 */
  async terminateSessions(id: string, actor: SessionUser, meta: RequestMeta): Promise<{ count: number }> {
    const result = await this.db.transaction(async (tx) => {
      const count = await this.users.terminateSessions(id, actor, tx);
      await this.audit.record({ action: 'user.sessions.terminate', actorId: actor.id, targetType: 'user', targetId: id, detail: { count }, ip: meta.ip }, tx);
      return { count };
    });
    this.revocation.revoke(id);
    return result;
  }

  /** 임시 비밀번호는 **응답에 한 번만** 실린다. 저장하지 않고 감사로그에도 남기지 않는다 (FR-209, FR-238) */
  async resetPassword(id: string, actor: SessionUser, meta: RequestMeta): Promise<{ user: UserView; temporaryPassword: string }> {
    // 임시 비밀번호의 해시는 트랜잭션을 열기 전에 (P13 FR-1434)
    const prepared = await this.users.prepareTemporaryPassword();
    const result = await this.db.transaction(async (tx) => {
      const { user, temporaryPassword } = await this.users.resetPassword(id, actor, tx, prepared);
      await this.audit.record({ action: 'user.password.reset', actorId: actor.id, targetType: 'user', targetId: id, ip: meta.ip }, tx);
      // 그 사람이 비밀번호 찾기로 남긴 요청은 처리됐다 — 받은 관리자 모두의 알림함에서 읽음이 된다 (P17 FR-1803)
      await this.notifications.resolveRecoveryRequests(id, tx);
      return { user: toUserView(user), temporaryPassword };
    });
    // 끊는 알림은 커밋한 뒤에 — 정지와 같다 (좁은 자체 점검 5)
    this.revocation.revoke(id);
    return result;
  }

  changeRole(id: string, role: Role, actor: SessionUser, meta: RequestMeta): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const { row, clearedGrants } = await this.users.changeRole(id, role, actor, tx);
      // 관리자가 아니게 되어 위임이 사라졌으면 같은 행에 남긴다 (P11 FR-1205)
      const detail = { role, ...(clearedGrants.length ? { clearedGrants } : {}) };
      await this.audit.record({ action: 'user.role.change', actorId: actor.id, targetType: 'user', targetId: id, detail, ip: meta.ip }, tx);
      return toUserView(row);
    });
  }

  /**
   * 위임을 주고 거둔다 (P11_설계서_Ops D.1·F절 · P15_설계서_Grants D.1·F절). 무엇을 줄 수 있는지는 서비스가 규칙표로 본다.
   * 목록 전체를 받고, 화면이 본 목록(`expected`)이 서버의 것과 다르면 409다
   */
  changeGrants(id: string, dto: UserGrantsDto, actor: SessionUser, meta: RequestMeta): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const { row, before, after, changed } = await this.users.changeGrants(id, dto.grants, actor, tx, dto.expected);
      // 바뀐 것이 없으면 남기지 않는다 — 같은 목록을 다시 보낸 것은 권한 변경이 아니다 (P11 코드 리뷰 9)
      if (changed) {
        await this.audit.record(
          { action: 'user.grants.change', actorId: actor.id, targetType: 'user', targetId: id, detail: { username: row.username, before, after }, ip: meta.ip },
          tx,
        );
      }
      return toUserView(row);
    });
  }
}
