import { Inject, Injectable } from '@nestjs/common';
import type { CreateTemplateDto, PageTemplateView, UpdateTemplateDto } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { TemplatesService } from './templates.service';

/**
 * 템플릿 만들기·고치기·지우기 (P6_설계서_Collab E절). 권한 판정은 서비스가 한다.
 * 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절). 목록은 서비스를 바로 부른다
 */
@Injectable()
export class TemplateUseCases {
  constructor(
    private readonly svc: TemplatesService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  create(dto: CreateTemplateDto, me: SessionUser, meta: RequestMeta): Promise<PageTemplateView> {
    return this.db.transaction(async (tx) => {
      const { template, created } = await this.svc.create(dto, me, tx);
      // **새로 만들었을 때만 기록한다.** 멱등 호출까지 남기면 감사로그가 "만들었다"로
      // 가득 차는데 실제로 바뀐 것은 없다 (FR-745·746)
      if (created) {
        await this.audit.record(
          { action: 'template.create', actorId: me.id, targetType: 'template', targetId: template.id, detail: { name: template.name }, ip: meta.ip },
          tx,
        );
      }
      return template;
    });
  }

  update(id: string, dto: UpdateTemplateDto, me: SessionUser, meta: RequestMeta): Promise<PageTemplateView> {
    return this.db.transaction(async (tx) => {
      const t = await this.svc.update(id, dto, me, tx);
      await this.audit.record({ action: 'template.update', actorId: me.id, targetType: 'template', targetId: id, detail: { name: t.name }, ip: meta.ip }, tx);
      return t;
    });
  }

  async remove(id: string, me: SessionUser, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const t = await this.svc.get(id, tx);
      await this.svc.remove(id, me, tx);
      await this.audit.record({ action: 'template.delete', actorId: me.id, targetType: 'template', targetId: id, detail: { name: t.name }, ip: meta.ip }, tx);
    });
  }
}
