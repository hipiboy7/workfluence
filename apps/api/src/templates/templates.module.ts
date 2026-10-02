import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { createTemplateDto, updateTemplateDto, type PageTemplateView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { metaOf } from '../common/request-meta';
import { ZodPipe } from '../common/zod.pipe';
import { TemplatesService } from './templates.service';
import { TemplateUseCases } from './templates.usecases';

/** 템플릿 API (P6_설계서_Collab E절). 권한 판정은 서비스가 한다 — 가드는 로그인만 본다 */
@Controller('api/templates')
@UseGuards(AuthGuard)
export class TemplatesController {
  constructor(
    private readonly svc: TemplatesService,
    private readonly uc: TemplateUseCases,
  ) {}

  /** 목록은 누구나 — 새 페이지를 만들 때 골라야 한다 */
  @Get()
  list(): Promise<PageTemplateView[]> {
    return this.svc.list();
  }

  @Post()
  create(
    @Body(new ZodPipe(createTemplateDto)) dto: ReturnType<typeof createTemplateDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<PageTemplateView> {
    return this.uc.create(dto, me, metaOf(req));
  }

  @Patch(':id')
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateTemplateDto)) dto: ReturnType<typeof updateTemplateDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<PageTemplateView> {
    return this.uc.update(id, dto, me, metaOf(req));
  }

  @Delete(':id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.remove(id, me, metaOf(req));
    return { ok: true };
  }
}

@Module({ providers: [TemplatesService, TemplateUseCases], controllers: [TemplatesController], exports: [TemplatesService, TemplateUseCases] })
export class TemplatesModule {}
