import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { createCommentDto, updateCommentDto, type CommentView, type CreateCommentDto, type UpdateCommentDto } from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { CommentUseCases } from './comments.usecases';
import { CommentsService } from './comments.service';


@Controller('api')
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(
    private readonly svc: CommentsService,
    private readonly uc: CommentUseCases,
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
    return this.uc.create(pageId, dto, me, metaOf(req));
  }

  @Patch('comments/:id')
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateCommentDto)) dto: UpdateCommentDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<CommentView> {
    return this.uc.update(id, dto, me, metaOf(req));
  }

  @Delete('comments/:id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.remove(id, me, metaOf(req));
    return { ok: true };
  }
}

@Module({ providers: [CommentsService, CommentUseCases], controllers: [CommentsController], exports: [CommentsService, CommentUseCases] })
export class CommentsModule {}
