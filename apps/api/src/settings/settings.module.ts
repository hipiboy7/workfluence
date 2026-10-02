import { Body, Controller, Get, Global, Module, Patch, Req, UseGuards } from '@nestjs/common';
import { policyPatchDto, type PolicyPatchDto } from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { PolicyUseCases, type PolicyRead } from './policy.usecases';
import { SettingsService } from './settings.service';

/** 운영 정책값 API (P4_설계서_Admin C절). 변경은 `settings.manage` 권한자만 (FR-526). 규칙은 `PolicyUseCases`에 있다 */
@Controller('api/settings/policy')
@UseGuards(AuthGuard)
export class PolicyController {
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

@Global()
@Module({ providers: [SettingsService, PolicyUseCases], controllers: [PolicyController], exports: [SettingsService, PolicyUseCases] })
export class SettingsModule {}
