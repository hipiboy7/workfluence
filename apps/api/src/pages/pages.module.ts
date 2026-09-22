import { BadRequestException, Body, Controller, Delete, Get, Inject, Module, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  createPageDto,
  movePageDto,
  updatePageDto,
  type DocNode,
  type PageSummary,
  type PageDiffView,
  type PageVersionView,
  type PageView,
} from '@workfluence/shared';
import type { Request, Response } from 'express';
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
    private readonly collab: CollabGateway,
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

  /**
   * 실시간 편집 중인 문서를 **지금 바로** 버전으로 남긴다 (FR-706의 사람 쪽 문).
   *
   * 화면의 저장 버튼이 이것을 부른다. 유휴를 기다리게 하면 "지금 저장한다"는 약속과
   * 동작이 어긋난다. 남길 것이 없으면(방이 없거나 내용이 그대로) 그냥 `saved: false`다 —
   * 오류가 아니다.
   */
  @Post(':id/collab/flush')
  async flush(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<{ saved: boolean; currentVersionNo: number }> {
    // **권한을 여기서 본다.** WebSocket을 거치지 않고 부를 수 있는 경로다
    await this.pages.get(id, me);
    const saved = await this.collab.flush(id);
    const after = await this.pages.get(id, me);
    return { saved, currentVersionNo: after.currentVersionNo };
  }

  /** 두 버전의 차이 (FR-720). 읽을 수 있으면 볼 수 있다 */
  @Get(':id/versions/:a/diff/:b')
  diff(
    @Param('id', UuidPipe) id: string,
    @Param('a', ParseIntPipe) a: number,
    @Param('b', ParseIntPipe) b: number,
    @CurrentUser() me: SessionUser,
  ): Promise<PageDiffView> {
    return this.pages.diff(id, a, b, me);
  }

  /**
   * HTML 한 파일로 내보낸다 (FR-730~737).
   *
   * **감사로그에 남긴다** (FR-736). 문서가 앱 밖으로 나가는 경로라 "누가 언제 무엇을"이
   * 남아야 한다 — 첨부 다운로드를 남기는 것과 같은 판단이다 (6절).
   */
  @Get(':id/export')
  async exportHtml(
    @Param('id', UuidPipe) id: string,
    @Query('versionNo') versionNo: string | undefined,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const no = versionNo === undefined ? undefined : Number(versionNo);
    if (no !== undefined && !Number.isInteger(no)) throw new BadRequestException('versionNo는 정수다');
    const out = await this.pages.exportHtml(id, me, no);
    await this.audit.record({ action: 'page.export', actorId: me.id, targetType: 'page', targetId: id, detail: { versionNo: out.versionNo }, ip: req.ip });
    res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      // **파일로 받게 한다.** 브라우저가 열어 버리면 내보낸 문서가 우리 오리진에서
      // 실행되는 셈이고, 그러면 본문이 우리 CSP 안에서 도는 길이 생긴다
      .setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`)
      .setHeader('Cache-Control', 'no-store')
      .send(out.html);
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
