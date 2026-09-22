import { Body, Controller, Delete, Get, Inject, Module, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { createTemplateDto, updateTemplateDto, type PageTemplateView } from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { TemplatesService } from './templates.service';

/** 템플릿 API (P6_설계서_Collab E절). 권한 판정은 서비스가 한다 — 가드는 로그인만 본다 */
@Controller('api/templates')
@UseGuards(AuthGuard)
export class TemplatesController {
  constructor(
    private readonly svc: TemplatesService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
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
    return this.db.transaction(async (tx) => {
      const { template, created } = await this.svc.create(dto, me, tx);
      // **새로 만들었을 때만 기록한다.** 멱등 호출까지 남기면 감사로그가 "만들었다"로
      // 가득 차는데 실제로 바뀐 것은 없다 (FR-745·746)
      if (created) {
        await this.audit.record(
          { action: 'template.create', actorId: me.id, targetType: 'template', targetId: template.id, detail: { name: template.name }, ip: req.ip },
          tx,
        );
      }
      return template;
    });
  }

  @Patch(':id')
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updateTemplateDto)) dto: ReturnType<typeof updateTemplateDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<PageTemplateView> {
    return this.db.transaction(async (tx) => {
      const t = await this.svc.update(id, dto, me, tx);
      await this.audit.record(
        { action: 'template.update', actorId: me.id, targetType: 'template', targetId: id, detail: { name: t.name }, ip: req.ip },
        tx,
      );
      return t;
    });
  }

  @Delete(':id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const t = await this.svc.get(id, tx);
      await this.svc.remove(id, me, tx);
      await this.audit.record(
        { action: 'template.delete', actorId: me.id, targetType: 'template', targetId: id, detail: { name: t.name }, ip: req.ip },
        tx,
      );
    });
    return { ok: true };
  }
}

@Module({ providers: [TemplatesService], controllers: [TemplatesController], exports: [TemplatesService] })
export class TemplatesModule {}
