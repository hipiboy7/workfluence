import { Body, Controller, Get, Global, Inject, Module, Patch, Req, UseGuards } from '@nestjs/common';
import { can, policyPatchDto, type Policy, type PolicyPatchDto } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { SettingsService } from './settings.service';

/** 운영 정책값 API (P4_설계서_Admin C절). 변경은 `settings.manage` 권한자만 (FR-526) */
@Controller('api/settings/policy')
@UseGuards(AuthGuard)
export class PolicyController {
  constructor(
    private readonly svc: SettingsService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * 읽기.
   *
   * **일반 사용자에게는 자기가 지켜야 할 것만 준다** — 업로드 상한·확장자·비밀번호 규칙.
   * 잠금 임계·잠금 시간·세션 시간은 주지 않는다. 잠금 회피 간격을 계산할 수 있는 값이라,
   * 화면이 쓰지도 않는데 모두에게 흘릴 이유가 없다 (자체 점검 11).
   */
  @Get()
  async get(@CurrentUser() me: SessionUser): Promise<Partial<Policy> & { uploadCeilingMb: number }> {
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

  @Patch()
  @RequireAction('settings.manage')
  update(@Body(new ZodPipe(policyPatchDto)) patch: PolicyPatchDto, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    return this.db.transaction(async (tx) => {
      const { before, after } = await this.svc.update(patch, me, tx);
      // **바뀐 키의 이전·이후를 남긴다** (FR-525). "누가 바꿨다"만으로는 되돌릴 수 없다
      await this.audit.record({ action: 'settings.update', actorId: me.id, targetType: 'settings', targetId: 'policy', detail: { before, after }, ip: req.ip }, tx);
      return { ok: true as const };
    });
  }
}

@Global()
@Module({ providers: [SettingsService], controllers: [PolicyController], exports: [SettingsService] })
export class SettingsModule {}
