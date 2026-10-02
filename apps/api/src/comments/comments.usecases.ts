import { Inject, Injectable } from '@nestjs/common';
import type { CommentView, CreateCommentDto, UpdateCommentDto } from '@workfluence/shared';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { pages } from '../db/schema';
import { MentionMailService } from '../mail/mention-mail.service';
import type { MentionOutcome } from '../notifications/notifications.service';
import { CommentsService } from './comments.service';

/**
 * 댓글 쓰기·고치기·지우기 (P3_설계서_Content). 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절).
 * 멘션 메일은 **커밋된 뒤에** 보낸다 (FR-754). 목록은 서비스를 바로 부른다
 */
@Injectable()
export class CommentUseCases {
  constructor(
    private readonly svc: CommentsService,
    private readonly audit: AuditService,
    private readonly mentionMail: MentionMailService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async create(pageId: string, dto: CreateCommentDto, me: SessionUser, meta: RequestMeta): Promise<CommentView> {
    const collected: MentionOutcome[] = [];
    const view = await this.db.transaction(async (tx) => {
      const v = await this.svc.create(pageId, dto, me, tx, (m) => collected.push(m));
      await this.audit.record(
        { action: 'comment.create', actorId: me.id, targetType: 'comment', targetId: v.id, detail: { pageId, parentId: dto.parentId ?? null }, ip: meta.ip },
        tx,
      );
      return v;
    });
    // 커밋된 뒤에 보낸다 (FR-754). 기다리지 않는다 — 메일이 느려도 댓글 응답은 나가야 한다
    const mentions = collected[0];
    if (mentions?.count) {
      // **실제 제목을 넘긴다.** 자리표시자가 그대로 메일에 나가고 있었다 (자체 점검 20)
      // **제목만 필요하다.** `PagesService`를 끌어오면 모듈 의존이 늘어난다 —
      // 권한은 댓글을 만들 때 이미 봤으므로 여기서는 제목 한 칸만 읽는다
      const row = await this.db.query.pages.findFirst({ where: eq(pages.id, pageId), columns: { title: true } });
      // 일으킨 사람을 넘긴다 — 빠뜨리면 `mail.send` 감사의 actor가 빈다 (P8 FR-906). 발송은 스스로 실패를 기록한다 — 여기서 던지면 응답 뒤의 처리되지 않은 거절이 된다
      this.mentionMail.notify(mentions, me.displayName, row?.title ?? '문서', me.id).catch(() => undefined);
    }
    return view;
  }

  update(id: string, dto: UpdateCommentDto, me: SessionUser, meta: RequestMeta): Promise<CommentView> {
    return this.db.transaction(async (tx) => {
      const view = await this.svc.update(id, dto, me, tx);
      await this.audit.record({ action: 'comment.update', actorId: me.id, targetType: 'comment', targetId: id, detail: { pageId: view.pageId }, ip: meta.ip }, tx);
      return view;
    });
  }

  async remove(id: string, me: SessionUser, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.svc.remove(id, me, tx);
      await this.audit.record({ action: 'comment.delete', actorId: me.id, targetType: 'comment', targetId: id, detail: { pageId: row.pageId }, ip: meta.ip }, tx);
    });
  }
}
