import { Controller, Get, Global, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { listLimitDto, type NotificationView } from '@workfluence/shared';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { InAppChannel, NOTIFY, NotificationsService } from './notifications.service';

/**
 * 알림함 (P4_설계서_Admin C절).
 *
 * **자기 것만 보는 경로뿐이다** (FR-508). 사용자 id를 받는 엔드포인트를 두지 않는 것이
 * 곧 남의 알림을 못 보게 하는 방법이다 — 가드로 거르는 것보다 확실하다.
 */
@Controller('api/notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(
    @Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<NotificationView[]> {
    return this.svc.list(me, q.limit);
  }

  @Get('unread-count')
  async unread(@CurrentUser() me: SessionUser): Promise<{ count: number }> {
    return { count: await this.svc.unreadCount(me) };
  }

  /** 알림 생성·읽음은 감사로그에 남기지 않는다 (FR-507) — 양이 불어나고 추적 가치가 낮다 */
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

@Global()
@Module({
  providers: [NotificationsService, { provide: NOTIFY, useClass: InAppChannel }],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
