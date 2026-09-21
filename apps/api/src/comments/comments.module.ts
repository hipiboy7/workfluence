import { Body, Controller, Delete, Get, Inject, Module, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { createCommentDto, updateCommentDto, type CommentView, type CreateCommentDto, type UpdateCommentDto } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { CommentsService } from './comments.service';

@Controller('api')
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(
    private readonly svc: CommentsService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('pages/:pageId/comments')
  list(@Param('pageId', UuidPipe) pageId: string, @CurrentUser() me: SessionUser): Promise<CommentView[]> {
    return this.svc.list(pageId, me);
  }

  @Post('pages/:pageId/comments')
  create(
    @Param('pageId', UuidPipe) pageId: string,
    @Body(new ZodPipe(createCommentDto)) dto: CreateCommentDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CommentView> {
    return this.db.transaction(async (tx) => {
      const view = await this.svc.create(pageId, dto, me, tx);
      await this.audit.record(
        { action: 'comment.create', actorId: me.id, targetType: 'comment', targetId: view.id, detail: { pageId, parentId: dto.parentId ?? null }, ip: req.ip },
        tx,
      );
      return view;
    });
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
