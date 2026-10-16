import { ConflictException, Controller, NotFoundException, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, Body } from '@nestjs/common';
import {
  capItems,
  docToBody,
  v1CreatePageDto,
  v1ExportQuery,
  v1MovePageDto,
  v1PageQuery,
  v1PageTreeQuery,
  v1VersionNo,
  type V1PageTreeQuery,
  type V1PageSummary,
  matchesAuthor,
  withAuthorship,
  v1UpdatePageDto,
  type PageDiffView,
  type V1PageQuery,
  type V1PageView,
  type V1VersionView,
  type PageVersionView,
} from '@workfluence/shared';
import type { Request, Response } from 'express';
import { CurrentUser, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { PagesService } from '../pages/pages.service';
import { PageUseCases } from '../pages/pages.usecases';
import { CollabGateway } from '../pages/collab/collab.gateway';
import { SpacesService } from '../spaces/spaces.service';
import { UsersService } from '../users/users.service';
import { resolveSpaceRef } from './space-ref';
import { resolveUserRefs, type UserLookup } from './user-ref';
import { UseV1 } from './use-v1';

/** 실시간 편집 중인지 — 게이트웨이의 좁은 면 (2절 ISP). 시험은 대역을 넣는다 */
export interface LiveEditing {
  hasLiveEditors(pageId: string): boolean;
}

/**
 * 공개 API v1 — 페이지 (docs/spinoff/public-api 설계서 3.3·3.5절).
 *
 * **얇은 층이다** (FR-2210) — 트랜잭션·감사·멘션 메일은 화면용과 같은 `PageUseCases`가 한다. 여기서 하는 일은 에이전트용 단순 계약뿐이다: 스페이스를
 * 이름으로 고르고, 마크다운 본문을 받고, 안 준 값은 기본값으로 채우고, 편집 중인 페이지는 건드리지 않는다. 가드는 토큰(scope·사람의 권한)이다 —
 * 세션은 보지 않는다.
 */
@Controller('api/v1/pages')
@UseV1()
export class V1PagesController {
  constructor(
    private readonly pages: PagesService,
    private readonly uc: PageUseCases,
    private readonly spaces: SpacesService,
    @Inject(CollabGateway) private readonly live: LiveEditing,
    @Inject(UsersService) private readonly users: UserLookup,
  ) {}

  private async view(id: string, me: SessionUser, format: V1PageQuery['format']): Promise<V1PageView> {
    const [page, ancestors] = await Promise.all([this.pages.get(id, me), this.pages.ancestors(id, me)]);
    const who = (await this.pages.authorship([page.id])).get(page.id);
    if (!who) throw new NotFoundException('페이지를 찾을 수 없다');
    return {
      id: page.id,
      spaceId: page.spaceId,
      parentId: page.parentId,
      title: page.title,
      position: page.position,
      currentVersionNo: page.currentVersionNo,
      updatedAt: page.updatedAt,
      ...who,
      format,
      body: docToBody(format, page.content),
      ancestors,
    };
  }

  /**
   * **편집 중인 페이지는 건드리지 않는다** (G2, FR-2216). 정본을 바꾸면 방이 앞선 정본을 만나 사람의 저장 전 입력을 버린다. 쓰기 권한을 **먼저** 본다 —
   * 쓸 수 없는 사람에게 "누가 편집 중"이라는 사실보다 403이 먼저다
   */
  private async assertWritableNow(id: string, me: SessionUser): Promise<Awaited<ReturnType<PagesService['get']>>> {
    const page = await this.pages.get(id, me);
    await this.spaces.assertWrite(page.spaceId, me);
    if (this.live.hasLiveEditors(id)) {
      throw new ConflictException({
        code: 'PAGE_BEING_EDITED',
        message: '사람이 이 페이지를 실시간으로 편집하고 있다 — 지금 저장하면 그 사람의 입력이 사라진다. 편집이 끝난 뒤 다시 시도한다',
      });
    }
    return page;
  }

  /** 스페이스의 페이지 트리 — 본문 없이. 만든 사람·고친 사람을 싣고 그것으로 거른다 — 자르기 전에 걸러야 `total`·`truncated`가 맞다 (F-023) */
  @Get()
  async list(
    @Query(new ZodPipe(v1PageTreeQuery)) query: V1PageTreeQuery,
    @CurrentUser() me: SessionUser,
  ): Promise<{ space: { id: string; name: string }; items: V1PageSummary[]; total: number; truncated: boolean }> {
    const target = await resolveSpaceRef(this.spaces, query.space, me);
    const by = await resolveUserRefs(this.users, { createdBy: query.createdBy, updatedBy: query.updatedBy });
    const tree = await this.pages.tree(target.id, me);
    const all = withAuthorship(tree, await this.pages.authorship(tree.map((p) => p.id))).filter((p) => matchesAuthor(p, by));
    return { space: target, ...capItems(all, query.limit), total: all.length };
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery, @CurrentUser() me: SessionUser): Promise<V1PageView> {
    return this.view(id, me, query.format);
  }

  /** 페이지 만들기 — 필수는 `space`·`title`·`body`. 부모는 없으면 맨 위, 위치는 맨 끝 */
  @Post()
  async create(
    @Body(new ZodPipe(v1CreatePageDto)) dto: ReturnType<typeof v1CreatePageDto.parse>,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1PageView> {
    const target = await resolveSpaceRef(this.spaces, dto.space, me);
    const page = await this.uc.create({ spaceId: target.id, parentId: dto.parentId, title: dto.title, content: dto.doc }, me, metaOf(req));
    return this.view(page.id, me, query.format);
  }

  /** 고칠 것만 — 안 준 제목·본문은 그대로. **기준 버전은 꼭 보낸다**(없으면 400). 편집 중이면 409 */
  @Patch(':id')
  async update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1UpdatePageDto)) dto: ReturnType<typeof v1UpdatePageDto.parse>,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1PageView> {
    const current = await this.assertWritableNow(id, me);
    await this.uc.update(id, { title: dto.title ?? current.title, content: dto.doc ?? current.content, baseVersionNo: dto.baseVersionNo }, me, metaOf(req));
    return this.view(id, me, query.format);
  }

  /** 옮기기 — 위치를 안 주면 맨 끝 */
  @Patch(':id/move')
  async move(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1MovePageDto)) dto: ReturnType<typeof v1MovePageDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1PageSummary> {
    const { page } = await this.uc.move(id, dto, me, metaOf(req));
    // 목록의 항목과 같은 모양이다 — 만든 사람·고친 사람도 (F-023)
    const [moved] = withAuthorship([page], await this.pages.authorship([page.id]));
    if (!moved) throw new NotFoundException('페이지를 찾을 수 없다');
    return moved;
  }

  @Delete(':id')
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    return this.uc.remove(id, me, metaOf(req));
  }

  @Get(':id/versions')
  versions(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<PageVersionView[]> {
    return this.pages.versions(id, me);
  }

  @Get(':id/versions/:no')
  async version(
    @Param('id', UuidPipe) id: string,
    @Param('no', new ZodPipe(v1VersionNo)) no: number,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
  ): Promise<V1VersionView> {
    const v = await this.pages.version(id, no, me);
    return { versionNo: v.versionNo, title: v.title, createdByName: v.createdByName, createdAt: v.createdAt, format: query.format, body: docToBody(query.format, v.content) };
  }

  /** 옛 버전으로 되돌린다 — 편집 중이면 409(방의 상태를 덮어쓰지 않는다) */
  @Post(':id/versions/:no/restore')
  async restore(
    @Param('id', UuidPipe) id: string,
    @Param('no', new ZodPipe(v1VersionNo)) no: number,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1PageView> {
    await this.assertWritableNow(id, me);
    await this.uc.restoreVersion(id, no, me, metaOf(req));
    return this.view(id, me, query.format);
  }

  /** 두 버전의 차이 — 화면용과 같은 모양 */
  @Get(':id/versions/:a/diff/:b')
  diff(
    @Param('id', UuidPipe) id: string,
    @Param('a', new ZodPipe(v1VersionNo)) a: number,
    @Param('b', new ZodPipe(v1VersionNo)) b: number,
    @CurrentUser() me: SessionUser,
  ): Promise<PageDiffView> {
    return this.pages.diff(id, a, b, me);
  }

  /** HTML 한 파일로 내보낸다 — **파일로 받게 한다**(열어 버리면 내보낸 문서가 우리 오리진에서 도는 길이 생긴다). 감사는 유스케이스가 남긴다 (FR-736) */
  @Get(':id/export')
  async exportHtml(
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(v1ExportQuery)) query: { versionNo?: number },
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const out = await this.uc.exportHtml(id, query.versionNo, me, metaOf(req));
    res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`)
      .setHeader('Cache-Control', 'no-store')
      .send(out.html);
  }
}
