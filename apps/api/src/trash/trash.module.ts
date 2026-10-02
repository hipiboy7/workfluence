import { Controller, Get, Module, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { listLimitDto, type TrashPageView, type TrashSpaceView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { metaOf } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { TrashService } from './trash.service';
import { TrashUseCases } from './trash.usecases';

/** 휴지통 API (P4_설계서_Admin C절). 되살리기는 감사로그에 남는다 (FR-514) */
@Controller('api/trash')
@UseGuards(AuthGuard)
export class TrashController {
  constructor(
    private readonly svc: TrashService,
    private readonly uc: TrashUseCases,
  ) {}

  @Get('pages')
  pages(
    @Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<TrashPageView[]> {
    return this.svc.listPages(me, q.limit);
  }

  @Post('pages/:id/restore')
  restorePage(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true; movedToRoot: boolean }> {
    return this.uc.restorePage(id, me, metaOf(req));
  }

  @Get('spaces')
  spaces(
    @Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<TrashSpaceView[]> {
    return this.svc.listSpaces(me, q.limit);
  }

  @Post('spaces/:id/restore')
  async restoreSpace(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.restoreSpace(id, me, metaOf(req));
    return { ok: true };
  }
}

@Module({ providers: [TrashService, TrashUseCases], controllers: [TrashController], exports: [TrashService, TrashUseCases] })
export class TrashModule {}
