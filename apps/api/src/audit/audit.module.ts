import { Controller, Get, Global, Inject, Injectable, Module, Query, UseGuards } from '@nestjs/common';
import type { AuditAction, AuditEventView } from '@workfluence/shared';
import { desc, eq, sql } from 'drizzle-orm';
import { AuthGuard, RequireAction } from '../auth/auth.guard';
import { DB, type Db } from '../db/db.module';
import { auditEvents, users } from '../db/schema';

export type AuditInput = {
  action: AuditAction;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
};

/** 감사로그는 append-only (CLAUDE.md 6절). 기록 실패가 본 작업을 되돌리지 않도록 호출부는 같은 트랜잭션 안에서 부른다. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(input: AuditInput, tx: Db = this.db): Promise<void> {
    await tx.insert(auditEvents).values({
      action: input.action,
      actorId: input.actorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detail: input.detail ?? null,
      ip: input.ip ?? null,
    });
  }

  async list(limit: number): Promise<AuditEventView[]> {
    const rows = await this.db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        actorId: auditEvents.actorId,
        actorName: users.displayName,
        targetType: auditEvents.targetType,
        targetId: auditEvents.targetId,
        detail: auditEvents.detail,
        ip: auditEvents.ip,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      detail: (r.detail as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

@Controller('api/audit')
@UseGuards(AuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireAction('audit.read')
  list(@Query('limit') limit?: string): Promise<AuditEventView[]> {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.audit.list(n);
  }
}

// sql import는 향후 보존 기간 배치용으로 남긴다
void sql;

/** 전역 모듈: 모든 쓰기 모듈이 AuditService를 쓰고, 가드(AuthGuard)가 어느 모듈에서든 해석돼야 한다 */
@Global()
@Module({
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
