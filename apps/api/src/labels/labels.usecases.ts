import { Inject, Injectable } from '@nestjs/common';
import type { LabelView } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { LabelsService } from './labels.service';

/**
 * 라벨 붙이기·떼기 (P4_설계서_Admin C절). 권한은 그 페이지의 스페이스 판정을 따른다 (FR-535) — 서비스가 본다.
 * 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절). 읽기는 서비스를 바로 부른다
 */
@Injectable()
export class LabelUseCases {
  constructor(
    private readonly svc: LabelsService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  attach(pageId: string, name: string, me: SessionUser, meta: RequestMeta): Promise<LabelView> {
    return this.db.transaction(async (tx) => {
      const label = await this.svc.attach(pageId, name, me, tx);
      await this.audit.record({ action: 'label.attach', actorId: me.id, targetType: 'page', targetId: pageId, detail: { label: label.name }, ip: meta.ip }, tx);
      return label;
    });
  }

  async detach(pageId: string, labelId: string, me: SessionUser, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.svc.detach(pageId, labelId, me, tx);
      await this.audit.record({ action: 'label.detach', actorId: me.id, targetType: 'page', targetId: pageId, detail: { labelId }, ip: meta.ip }, tx);
    });
  }
}
