import { type CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_ENV, type AppEnvToken } from '../config/config.module';

/** 채팅을 끄면(`WF_CHAT_ENABLED=false`) 채팅 경로는 없는 것과 같다 — 404 (FR-2420) */
@Injectable()
export class ChatEnabledGuard implements CanActivate {
  constructor(@Inject(APP_ENV) private readonly env: Pick<AppEnvToken, 'WF_CHAT_ENABLED'>) {}

  canActivate(): boolean {
    if (!this.env.WF_CHAT_ENABLED) throw new NotFoundException({ code: 'CHAT_DISABLED', message: '채팅이 꺼져 있다' });
    return true;
  }
}
