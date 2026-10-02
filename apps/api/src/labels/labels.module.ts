import { Body, Controller, Delete, Get, Module, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { attachLabelDto, listLimitDto, type AttachLabelDto, type LabelView, type SearchHit } from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { metaOf } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { LabelUseCases } from './labels.usecases';
import { LabelsService } from './labels.service';

/** 라벨 API (P4_설계서_Admin C절). 권한은 그 페이지의 스페이스 판정을 따른다 (FR-535) */
@Controller('api')
@UseGuards(AuthGuard)
export class LabelsController {
  constructor(
    private readonly svc: LabelsService,
    private readonly uc: LabelUseCases,
  ) {}

  @Get('labels')
  all(@Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>): Promise<LabelView[]> {
    return this.svc.all(q.limit);
  }

  @Get('labels/:name/pages')
  find(
    @Param('name', new ZodPipe(attachLabelDto.shape.name)) name: string,
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
    return this.uc.attach(pageId, dto.name, me, metaOf(req));
  }

  @Delete('pages/:pageId/labels/:labelId')
  async detach(
    @Param('pageId', UuidPipe) pageId: string,
    @Param('labelId', UuidPipe) labelId: string,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.uc.detach(pageId, labelId, me, metaOf(req));
    return { ok: true };
  }
}

@Module({ providers: [LabelsService, LabelUseCases], controllers: [LabelsController], exports: [LabelsService, LabelUseCases] })
export class LabelsModule {}
