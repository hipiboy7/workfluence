import { Inject, Injectable } from '@nestjs/common';
import type { CreateLlmProviderDto, LlmProviderAdminView } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { LlmProvidersService } from './providers.service';

/**
 * LLM 연결 등록·삭제 (FR-1100~1106). 권한(`llm.manage`)은 경로의 가드와 서비스가 본다.
 * 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절). 목록·연결 확인은 서비스를 바로 부른다(바꾸는 것이 없다)
 */
@Injectable()
export class LlmProviderUseCases {
  constructor(
    private readonly providers: LlmProvidersService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  create(dto: CreateLlmProviderDto, me: SessionUser, meta: RequestMeta): Promise<LlmProviderAdminView> {
    return this.db.transaction(async (tx) => {
      const view = await this.providers.create(dto, me, tx);
      // **키는 싣지 않는다** — 있다는 사실만 (FR-1102·1106)
      await this.audit.record(
        {
          action: 'llm.provider.create',
          actorId: me.id,
          targetType: 'llm.provider',
          targetId: view.id,
          detail: { name: view.name, baseUrl: view.baseUrl, model: view.model, hasKey: view.hasKey },
          ip: meta.ip,
        },
        tx,
      );
      return view;
    });
  }

  async remove(id: string, me: SessionUser, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const gone = await this.providers.remove(id, me, tx);
      await this.audit.record({ action: 'llm.provider.delete', actorId: me.id, targetType: 'llm.provider', targetId: id, detail: gone, ip: meta.ip }, tx);
    });
  }
}
