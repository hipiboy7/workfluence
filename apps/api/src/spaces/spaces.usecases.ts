import { Inject, Injectable } from '@nestjs/common';
import type { AddMemberDto, CreateSpaceDto, SpaceMemberView, SpaceStatusDto, SpaceView, UpdateMemberRoleDto, UpdateSpaceDto } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { SpacesService } from './spaces.service';

/**
 * 스페이스와 Crew (P2_설계서_Page 2절). 모든 쓰기는 감사로그와 **같은 트랜잭션**이다. 판정·잠금은 서비스가 본다. 화면용 경로와 공개 API가 함께
 * 부른다 (docs/spinoff/public-api 계획서 7.1절). 목록·읽기는 서비스를 바로 부른다
 */
@Injectable()
export class SpaceUseCases {
  constructor(
    private readonly spaces: SpacesService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async create(dto: CreateSpaceDto, me: SessionUser, meta: RequestMeta): Promise<SpaceView> {
    const row = await this.db.transaction(async (tx) => {
      const r = await this.spaces.create(dto, me, tx);
      await this.audit.record(
        { action: 'space.create', actorId: me.id, targetType: 'space', targetId: r.id, detail: { name: r.name, kind: r.kind }, ip: meta.ip },
        tx,
      );
      return r;
    });
    return this.spaces.get(row.id, me);
  }

  async update(id: string, dto: UpdateSpaceDto, me: SessionUser, meta: RequestMeta): Promise<SpaceView> {
    await this.db.transaction(async (tx) => {
      await this.spaces.update(id, dto, me, tx);
      await this.audit.record({ action: 'space.update', actorId: me.id, targetType: 'space', targetId: id, detail: dto, ip: meta.ip }, tx);
    });
    return this.spaces.get(id, me);
  }

  async changeStatus(id: string, dto: SpaceStatusDto, me: SessionUser, meta: RequestMeta): Promise<SpaceView> {
    await this.db.transaction(async (tx) => {
      const { row, changed, takeover, wasByOwner } = await this.spaces.changeStatus(id, dto.status, me, tx, { takeover: 'takeover' in dto && dto.takeover });
      // 같은 상태를 다시 보내면 쓰지 않고 감사 행도 남기지 않는다. 중지는 건 사람이 주인이었는지(넘겨받았으면 그것도), 다시 쓰기는 풀린 중지가
      // 누구 것이었는지를 남긴다 — "관리자가 건 중지를 누가 풀었나"를 앞 행을 찾지 않고 본다 (P15 FR-1610, 병합 전 보안 검토 후보 g)
      if (!changed) return;
      const detail =
        dto.status === 'suspended' ? { ...dto, byOwner: row.suspendedByOwner, ...(takeover ? { takeover: true } : {}) } : { ...dto, wasByOwner };
      await this.audit.record({ action: 'space.status.change', actorId: me.id, targetType: 'space', targetId: id, detail, ip: meta.ip }, tx);
    });
    // 읽지 못해도 바꿀 수 있는 사람(스페이스 관리 전체)에게 바꾼 뒤 404를 주지 않는다
    return this.spaces.getManaged(id, me);
  }

  async remove(id: string, me: SessionUser, meta: RequestMeta): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const row = await this.spaces.softDelete(id, me, tx);
      await this.audit.record({ action: 'space.delete', actorId: me.id, targetType: 'space', targetId: id, detail: { name: row.name }, ip: meta.ip }, tx);
    });
    return { ok: true };
  }

  // ---- Crew ----

  async addMember(id: string, dto: AddMemberDto, me: SessionUser, meta: RequestMeta): Promise<SpaceMemberView[]> {
    await this.db.transaction(async (tx) => {
      await this.spaces.addMember(id, dto, me, tx);
      await this.audit.record({ action: 'space.member.add', actorId: me.id, targetType: 'space', targetId: id, detail: dto, ip: meta.ip }, tx);
    });
    return this.spaces.members(id, me);
  }

  async changeMemberRole(id: string, userId: string, role: UpdateMemberRoleDto['role'], me: SessionUser, meta: RequestMeta): Promise<SpaceMemberView[]> {
    await this.db.transaction(async (tx) => {
      await this.spaces.changeMemberRole(id, userId, role, me, tx);
      await this.audit.record(
        { action: 'space.member.role.change', actorId: me.id, targetType: 'space', targetId: id, detail: { userId, role }, ip: meta.ip },
        tx,
      );
    });
    return this.spaces.members(id, me);
  }

  async removeMember(id: string, userId: string, me: SessionUser, meta: RequestMeta): Promise<SpaceMemberView[]> {
    await this.db.transaction(async (tx) => {
      await this.spaces.removeMember(id, userId, me, tx);
      await this.audit.record({ action: 'space.member.remove', actorId: me.id, targetType: 'space', targetId: id, detail: { userId }, ip: meta.ip }, tx);
    });
    return this.spaces.members(id, me);
  }
}
