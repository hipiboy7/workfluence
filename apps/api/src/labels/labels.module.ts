import { Body, Controller, Delete, Get, Inject, Module, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { attachLabelDto, listLimitDto, type AttachLabelDto, type LabelView, type SearchHit } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { LabelsService } from './labels.service';

/** 라벨 API (P4_설계서_Admin C절). 권한은 그 페이지의 스페이스 판정을 따른다 (FR-535) */
@Controller('api')
@UseGuards(AuthGuard)
export class LabelsController {
  constructor(
    private readonly svc: LabelsService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('labels')
  all(@Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>): Promise<LabelView[]> {
    return this.svc.all(q.limit);
  }

  @Get('labels/:name/pages')
  find(
    @Param('name') name: string,
    @Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<SearchHit[]> {
    return this.svc.findPages(name, me, q.limit);
  }

  @Get('pages/:pageId/labels')
  forPage(@Param('pageId', UuidPipe) pageId: string, @CurrentUser() me: SessionUser): Promise<LabelView[]> {
    return this.svc.forPage(pageId, me);
  }

  @Post('pages/:pageId/labels')
  attach(
    @Param('pageId', UuidPipe) pageId: string,
    @Body(new ZodPipe(attachLabelDto)) dto: AttachLabelDto,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<LabelView> {
    return this.db.transaction(async (tx) => {
      const label = await this.svc.attach(pageId, dto.name, me, tx);
      await this.audit.record({ action: 'label.attach', actorId: me.id, targetType: 'page', targetId: pageId, detail: { label: label.name }, ip: req.ip }, tx);
      return label;
    });
  }

  @Delete('pages/:pageId/labels/:labelId')
  async detach(
    @Param('pageId', UuidPipe) pageId: string,
    @Param('labelId', UuidPipe) labelId: string,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      await this.svc.detach(pageId, labelId, me, tx);
      await this.audit.record({ action: 'label.detach', actorId: me.id, targetType: 'page', targetId: pageId, detail: { labelId }, ip: req.ip }, tx);
    });
    return { ok: true };
  }
}

@Module({ providers: [LabelsService], controllers: [LabelsController], exports: [LabelsService] })
export class LabelsModule {}
