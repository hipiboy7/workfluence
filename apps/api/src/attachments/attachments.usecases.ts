import { Inject, Injectable } from '@nestjs/common';
import type { AttachmentView } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { AttachmentsService, type UploadedFileLike } from './attachments.service';

export type Downloaded = Awaited<ReturnType<AttachmentsService['download']>>;

/**
 * 첨부 올리기·내려받기·지우기 (P3_설계서_Content 5절). 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절).
 * 응답 머리(형식·파일명·nosniff)는 전송의 일이라 컨트롤러에 남는다. 목록은 서비스를 바로 부른다
 */
@Injectable()
export class AttachmentUseCases {
  constructor(
    private readonly svc: AttachmentsService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  upload(pageId: string, file: UploadedFileLike, me: SessionUser, meta: RequestMeta): Promise<AttachmentView> {
    return this.db.transaction(async (tx) => {
      const view = await this.svc.upload(pageId, file, me, tx);
      await this.audit.record(
        { action: 'attachment.upload', actorId: me.id, targetType: 'attachment', targetId: view.id, detail: { pageId, filename: view.filename, size: view.size }, ip: meta.ip },
        tx,
      );
      return view;
    });
  }

  /** 다운로드를 감사로그에 남긴다 (FR-419). 읽기지만 **무엇을 가져갔는지**는 남아야 한다 */
  download(id: string, me: SessionUser, meta: RequestMeta): Promise<Downloaded> {
    return this.db.transaction(async (tx) => {
      const got = await this.svc.download(id, me, tx);
      await this.audit.record(
        { action: 'attachment.download', actorId: me.id, targetType: 'attachment', targetId: id, detail: { pageId: got.row.pageId, filename: got.row.filename }, ip: meta.ip },
        tx,
      );
      return got;
    });
  }

  async remove(id: string, me: SessionUser, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.svc.remove(id, me, tx);
      await this.audit.record(
        { action: 'attachment.delete', actorId: me.id, targetType: 'attachment', targetId: id, detail: { pageId: row.pageId, filename: row.filename }, ip: meta.ip },
        tx,
      );
    });
  }
}
