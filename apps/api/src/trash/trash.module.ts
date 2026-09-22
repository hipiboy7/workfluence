import { Controller, Get, Inject, Module, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { listLimitDto, type TrashPageView, type TrashSpaceView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { TrashService } from './trash.service';

/** 휴지통 API (P4_설계서_Admin C절). 되살리기는 감사로그에 남는다 (FR-514) */
@Controller('api/trash')
@UseGuards(AuthGuard)
export class TrashController {
  constructor(
    private readonly svc: TrashService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
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
    return this.db.transaction(async (tx) => {
      const { page, movedToRoot } = await this.svc.restorePage(id, me, tx);
      await this.audit.record(
        { action: 'page.restore.trash', actorId: me.id, targetType: 'page', targetId: id, detail: { title: page.title, movedToRoot }, ip: req.ip },
        tx,
      );
      return { ok: true as const, movedToRoot };
    });
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
    await this.db.transaction(async (tx) => {
      const space = await this.svc.restoreSpace(id, me, tx);
      await this.audit.record({ action: 'space.restore', actorId: me.id, targetType: 'space', targetId: id, detail: { name: space.name }, ip: req.ip }, tx);
    });
    return { ok: true };
  }
}

@Module({ providers: [TrashService], controllers: [TrashController], exports: [TrashService] })
export class TrashModule {}
