import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  listLimitDto,
  toV1Template,
  v1PageQuery,
  v1TemplateDto,
  v1TemplateUpdateDto,
  type NotificationView,
  type TrashPageView,
  type TrashSpaceView,
  type V1PageQuery,
  type V1TemplateView,
} from '@workfluence/shared';
import type { Request } from 'express';
import { CurrentUser, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { NotificationsService } from '../notifications/notifications.service';
import { TemplatesService } from '../templates/templates.service';
import { TemplateUseCases } from '../templates/templates.usecases';
import { TrashService } from '../trash/trash.service';
import { TrashUseCases } from '../trash/trash.usecases';
import { UseV1 } from './use-v1';

type Limit = ReturnType<typeof listLimitDto.parse>;

/**
 * 공개 API v1 — 템플릿 (docs/spinoff/public-api 설계서 3.5절). 얇은 층이다(FR-2210) — 만들기·고치기·지우기는 관리자만이고(화면용과 같다) 감사는 같은
 * `TemplateUseCases`가 남긴다. 에이전트가 정하는 것은 **이름과 본문**이다(본문은 마크다운이 기본)
 */
@Controller('api/v1/templates')
@UseV1()
export class V1TemplatesController {
  constructor(
    private readonly svc: TemplatesService,
    private readonly uc: TemplateUseCases,
  ) {}

  /** 목록은 누구나 — 새 페이지를 만들 때 고른다 */
  @Get()
  async list(@Query(new ZodPipe(v1PageQuery)) query: V1PageQuery, @CurrentUser() _me: SessionUser): Promise<{ items: V1TemplateView[] }> {
    return { items: (await this.svc.list()).map((t) => toV1Template(t, query.format)) };
  }

  @Post()
  async create(
    @Body(new ZodPipe(v1TemplateDto)) dto: ReturnType<typeof v1TemplateDto.parse>,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1TemplateView> {
    return toV1Template(await this.uc.create(dto, me, metaOf(req)), query.format);
  }

  @Patch(':id')
  async update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1TemplateUpdateDto)) dto: ReturnType<typeof v1TemplateUpdateDto.parse>,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1TemplateView> {
    return toV1Template(await this.uc.update(id, dto, me, metaOf(req)), query.format);
  }

  @Delete(':id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.remove(id, me, metaOf(req));
    return { ok: true };
  }
}

/** 공개 API v1 — 휴지통. 보기와 되살리기뿐이다(물리 삭제는 보존 기간 뒤 배치가 한다). 되살리기는 감사에 남는다(FR-514) */
@Controller('api/v1/trash')
@UseV1()
export class V1TrashController {
  constructor(
    private readonly svc: TrashService,
    private readonly uc: TrashUseCases,
  ) {}

  @Get('pages')
  async pages(@Query(new ZodPipe(listLimitDto)) q: Limit, @CurrentUser() me: SessionUser): Promise<{ items: TrashPageView[] }> {
    return { items: await this.svc.listPages(me, q.limit) };
  }

  @Post('pages/:id/restore')
  restorePage(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true; movedToRoot: boolean }> {
    return this.uc.restorePage(id, me, metaOf(req));
  }

  @Get('spaces')
  async spaces(@Query(new ZodPipe(listLimitDto)) q: Limit, @CurrentUser() me: SessionUser): Promise<{ items: TrashSpaceView[] }> {
    return { items: await this.svc.listSpaces(me, q.limit) };
  }

  @Post('spaces/:id/restore')
  async restoreSpace(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.restoreSpace(id, me, metaOf(req));
    return { ok: true };
  }
}

/**
 * 공개 API v1 — 알림. **자기 것만 보는 경로뿐이다**(FR-508) — 사용자 id를 받는 경로를 두지 않는 것이 남의 알림을 못 보게 하는 방법이다.
 * 생성·읽음은 감사에 남기지 않는다(FR-507)
 */
@Controller('api/v1/notifications')
@UseV1()
export class V1NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  async list(@Query(new ZodPipe(listLimitDto)) q: Limit, @CurrentUser() me: SessionUser): Promise<{ items: NotificationView[] }> {
    return { items: await this.svc.list(me, q.limit) };
  }

  @Get('unread-count')
  async unread(@CurrentUser() me: SessionUser): Promise<{ count: number }> {
    return { count: await this.svc.unreadCount(me) };
  }

  @Post(':id/read')
  async read(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<{ ok: true }> {
    await this.svc.markRead(id, me);
    return { ok: true };
  }

  @Post('read-all')
  async readAll(@CurrentUser() me: SessionUser): Promise<{ count: number }> {
    return { count: await this.svc.markAllRead(me) };
  }
}
