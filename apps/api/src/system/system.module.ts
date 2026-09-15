import { Controller, Get, Inject, Module, UseGuards } from '@nestjs/common';
import type { SystemInfoView } from '@workfluence/shared';
import { count, eq, isNull, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuthGuard, RequireAction } from '../auth/auth.guard';
import { DB, type Db } from '../db/db.module';
import { auditEvents, pages, spaces, users } from '../db/schema';

/** root 전용 시스템 정보 (prototype-v2 2절 13번: 최소 구성, 이후 설계) */
@Controller('api/system')
@UseGuards(AuthGuard)
@RequireAction('system.manage')
export class SystemController {
  private readonly version: string;

  constructor(@Inject(DB) private readonly db: Db) {
    try {
      this.version = String(JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')).version);
    } catch {
      this.version = 'unknown';
    }
  }

  @Get('info')
  async info(): Promise<SystemInfoView> {
    const [{ pg }] = await this.db.execute<{ pg: string }>(sql`select version() as pg`).then((r) => r.rows);
    const [u] = await this.db.select({ n: count() }).from(users);
    const [p] = await this.db.select({ n: count() }).from(users).where(eq(users.status, 'pending'));
    const [s] = await this.db.select({ n: count() }).from(spaces).where(isNull(spaces.deletedAt));
    const [pg2] = await this.db.select({ n: count() }).from(pages).where(isNull(pages.deletedAt));
    const [a] = await this.db.select({ n: count() }).from(auditEvents);
    return {
      version: this.version,
      node: process.version,
      postgres: String(pg).split(',')[0],
      uptimeSec: Math.round(process.uptime()),
      counts: { users: u.n, pendingUsers: p.n, spaces: s.n, pages: pg2.n, auditEvents: a.n },
    };
  }
}

@Module({ controllers: [SystemController] })
export class SystemModule {}
