import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { TrashService } from './trash.service';

/**
 * 휴지통 되살리기 (P4_설계서_Admin C절). 되살리기는 감사로그에 남는다 (FR-514).
 * 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절). 목록은 서비스를 바로 부른다
 */
@Injectable()
export class TrashUseCases {
  constructor(
    private readonly svc: TrashService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  restorePage(id: string, me: SessionUser, meta: RequestMeta): Promise<{ ok: true; movedToRoot: boolean }> {
    return this.db.transaction(async (tx) => {
      const { page, movedToRoot } = await this.svc.restorePage(id, me, tx);
      await this.audit.record(
        { action: 'page.restore.trash', actorId: me.id, targetType: 'page', targetId: id, detail: { title: page.title, movedToRoot }, ip: meta.ip },
        tx,
      );
      return { ok: true as const, movedToRoot };
    });
  }

  async restoreSpace(id: string, me: SessionUser, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const space = await this.svc.restoreSpace(id, me, tx);
      await this.audit.record({ action: 'space.restore', actorId: me.id, targetType: 'space', targetId: id, detail: { name: space.name }, ip: meta.ip }, tx);
    });
  }
}
