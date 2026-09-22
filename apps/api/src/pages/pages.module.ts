import { Body, Controller, Delete, Get, Inject, Module, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  createPageDto,
  movePageDto,
  updatePageDto,
  type DocNode,
  type PageSummary,
  type PageVersionView,
  type PageView,
} from '@workfluence/shared';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { PagesService } from './pages.service';
import { CollabGateway } from './collab/collab.gateway';

/** 페이지 API (P2_설계서_Page 3절). 권한은 스페이스 판정을 따른다 — 여기서 다시 판정하지 않는다 */
@Controller('api/pages')
@UseGuards(AuthGuard)
export class PagesController {
  constructor(
    private readonly pages: PagesService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** 스페이스의 트리. `@RequireAction`이 없는 것은 "로그인한 사람이면 누구나"가 아니라, 스페이스 판정이 대신 거른다는 뜻이다 */
  @Get()
  tree(@Query('spaceId', UuidPipe) spaceId: string, @CurrentUser() me: SessionUser): Promise<PageSummary[]> {
    return this.pages.tree(spaceId, me);
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<PageView> {
    return this.pages.get(id, me);
  }

  @Post()
  create(
    @Body(new ZodPipe(createPageDto)) dto: ReturnType<typeof createPageDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<PageView> {
    return this.db.transaction(async (tx) => {
      const page = await this.pages.create(dto, me, tx);
      await this.audit.record(
        { action: 'page.create', actorId: me.id, targetType: 'page', targetId: page.id, detail: { spaceId: dto.spaceId, title: dto.title }, ip: req.ip },
        tx,
      );
      return page;
    });
  }

  @Patch(':id')
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(updatePageDto)) dto: ReturnType<typeof updatePageDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<PageView> {
    return this.db.transaction(async (tx) => {
      const page = await this.pages.update(id, dto, me, tx);
      await this.audit.record(
        { action: 'page.update', actorId: me.id, targetType: 'page', targetId: id, detail: { versionNo: page.currentVersionNo }, ip: req.ip },
        tx,
      );
      return page;
    });
  }

  @Patch(':id/move')
  move(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(movePageDto)) dto: ReturnType<typeof movePageDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<PageSummary> {
    return this.db.transaction(async (tx) => {
      const page = await this.pages.move(id, dto, me, tx);
      await this.audit.record({ action: 'page.move', actorId: me.id, targetType: 'page', targetId: id, detail: dto, ip: req.ip }, tx);
      return page;
    });
  }

  @Delete(':id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const page = await this.pages.softDelete(id, me, tx);
      await this.audit.record({ action: 'page.delete', actorId: me.id, targetType: 'page', targetId: id, detail: { title: page.title }, ip: req.ip }, tx);
    });
    return { ok: true };
  }

  @Get(':id/versions')
  versions(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<PageVersionView[]> {
    return this.pages.versions(id, me);
  }

  @Get(':id/versions/:no')
  version(
    @Param('id', UuidPipe) id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() me: SessionUser,
  ): Promise<PageVersionView & { content: DocNode }> {
    return this.pages.version(id, no, me);
  }

  @Post(':id/versions/:no/restore')
  restore(
    @Param('id', UuidPipe) id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<PageView> {
    return this.db.transaction(async (tx) => {
      const page = await this.pages.restoreVersion(id, no, me, tx);
      await this.audit.record(
        { action: 'page.version.restore', actorId: me.id, targetType: 'page', targetId: id, detail: { from: no, to: page.currentVersionNo }, ip: req.ip },
        tx,
      );
      return page;
    });
  }
}

@Module({
  providers: [PagesService, CollabGateway],
  controllers: [PagesController],
  // 게이트웨이를 내보낸다 — `main.ts`가 HTTP 서버에 붙이고 정리 명령이 고아 상태를 지운다
  exports: [PagesService, CollabGateway],
})
export class PagesModule {}
