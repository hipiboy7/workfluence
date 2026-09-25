import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { logLine } from '../common/log-line';

/** 컨테이너 헬스체크 대상 (CLAUDE.md 8.3절). DB까지 확인해야 "떠 있지만 쓸 수 없는" 상태를 잡는다. */
@Controller('api/health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check(): Promise<{ status: 'ok'; db: 'ok'; time: string }> {
    try {
      await this.db.execute(sql`select 1`);
    } catch (e) {
      // 원인을 삼키지 않는다. 응답에는 내부 사정을 싣지 않되, 로그에는 남겨야 운영자가 왜 degraded인지 안다.
      this.logger.error(logLine('health.db_failed', '헬스체크 DB 질의 실패', {}, e));
      throw new ServiceUnavailableException({ status: 'degraded', db: 'unreachable' });
    }
    return { status: 'ok', db: 'ok', time: new Date().toISOString() };
  }
}
