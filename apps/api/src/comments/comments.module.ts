import { Body, Controller, Delete, Get, Inject, Module, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { createCommentDto, updateCommentDto, type CommentView, type CreateCommentDto, type UpdateCommentDto } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { eq } from 'drizzle-orm';
import { pages } from '../db/schema';
import { CommentsService } from './comments.service';
import { MentionMailService } from '../mail/mention-mail.service';

import type { MentionOutcome } from '../notifications/notifications.service';

@Controller('api')
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(
    private readonly svc: CommentsService,
    private readonly audit: AuditService,
    private readonly mentionMail: MentionMailService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('pages/:pageId/comments')
  list(@Param('pageId', UuidPipe) pageId: string, @CurrentUser() me: SessionUser): Promise<CommentView[]> {
    return this.svc.list(pageId, me);
  }

  @Post('pages/:pageId/comments')
  async create(
    @Param('pageId', UuidPipe) pageId: string,
    @Body(new ZodPipe(createCommentDto)) dto: CreateCommentDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CommentView> {
    const collected: MentionOutcome[] = [];
    const view = await this.db.transaction(async (tx) => {
      const v = await this.svc.create(pageId, dto, me, tx, (m) => collected.push(m));
      await this.audit.record(
        { action: 'comment.create', actorId: me.id, targetType: 'comment', targetId: v.id, detail: { pageId, parentId: dto.parentId ?? null }, ip: req.ip },
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
      void this.mentionMail.notify(mentions, me.displayName, row?.title ?? '문서');
    }
    return view;
  }

  @Patch('comments/:id')
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateCommentDto)) dto: UpdateCommentDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CommentView> {
    return this.db.transaction(async (tx) => {
      const view = await this.svc.update(id, dto, me, tx);
      await this.audit.record({ action: 'comment.update', actorId: me.id, targetType: 'comment', targetId: id, detail: { pageId: view.pageId }, ip: req.ip }, tx);
      return view;
    });
  }

  @Delete('comments/:id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const row = await this.svc.remove(id, me, tx);
      await this.audit.record({ action: 'comment.delete', actorId: me.id, targetType: 'comment', targetId: id, detail: { pageId: row.pageId }, ip: req.ip }, tx);
    });
    return { ok: true };
  }
}

@Module({ providers: [CommentsService], controllers: [CommentsController], exports: [CommentsService] })
export class CommentsModule {}
