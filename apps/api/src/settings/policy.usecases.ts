import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { can, type Policy, type PolicyPatchDto } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { SettingsService } from './settings.service';

export type PolicyRead = Partial<Policy> & { uploadCeilingMb: number };

/**
 * 운영 정책값의 유스케이스 (P4_설계서_Admin C절). 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절).
 * 변경 권한(`settings.manage`)은 경로의 가드가 본다 — 여기는 그 안의 규칙(감사 단계는 root만)과 트랜잭션·감사·캐시 순서다.
 */
@Injectable()
export class PolicyUseCases {
  constructor(
    private readonly svc: SettingsService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * **일반 사용자에게는 자기가 지켜야 할 것만 준다** — 업로드 상한·확장자·비밀번호 규칙.
   * 잠금 임계·잠금 시간·세션 시간은 주지 않는다. 잠금 회피 간격을 계산할 수 있는 값이라,
   * 화면이 쓰지도 않는데 모두에게 흘릴 이유가 없다 (자체 점검 11).
   */
  async read(me: SessionUser): Promise<PolicyRead> {
    const p = await this.svc.get();
    const ceiling = { uploadCeilingMb: this.svc.uploadCeilingMb };
    if (can(me, 'settings.manage')) return { ...p, ...ceiling };
    return {
      uploadMaxMb: p.uploadMaxMb,
      allowedExtensions: p.allowedExtensions,
      passwordMinLength: p.passwordMinLength,
      passwordMinCharClasses: p.passwordMinCharClasses,
      ...ceiling,
    };
  }

  async update(patch: PolicyPatchDto, me: SessionUser, meta: RequestMeta): Promise<void> {
    // 감사 기록 단계는 **시스템 관리자만** 바꾼다 (P17 FR-1841 — 사용자 원문 "시스템 관리자가 감사로그 화면에서 … 지정"). 판정은 `can` — root 전용 행위다
    if (patch.auditLevel !== undefined && !can(me, 'system.manage')) throw new ForbiddenException('감사 기록 단계는 시스템 관리자만 바꾼다');
    await this.db.transaction(async (tx) => {
      const { before, after } = await this.svc.update(patch, me, tx);
      // **바뀐 키의 이전·이후를 남긴다** (FR-525). "누가 바꿨다"만으로는 되돌릴 수 없다
      await this.audit.record({ action: 'settings.update', actorId: me.id, targetType: 'settings', targetId: 'policy', detail: { before, after }, ip: meta.ip }, tx);
    });
    // **커밋된 뒤에 캐시를 버린다** (코드 리뷰 2). 트랜잭션 안에서 버리면 그 사이 들어온
    // 요청이 커밋 전 값을 읽어 굳혀 버린다 — `AuthGuard`가 요청마다 `get()`을 부르므로
    // 그 틈은 실제로 밟힌다
    this.svc.invalidate();
  }
}
