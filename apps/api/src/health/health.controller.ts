import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';

/** 컨테이너 헬스체크 대상 (CLAUDE.md 8.3절). DB까지 확인해야 "떠 있지만 쓸 수 없는" 상태를 잡는다. */
@Controller('api/health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check(): Promise<{ status: 'ok'; db: 'ok'; time: string }> {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', db: 'unreachable' });
    }
    return { status: 'ok', db: 'ok', time: new Date().toISOString() };
  }
}
