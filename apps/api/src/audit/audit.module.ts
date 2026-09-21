import { Controller, Get, Global, Module, Query, UseGuards } from '@nestjs/common';
import type { AuditEventView } from '@workfluence/shared';
import { AuthGuard, RequireAction } from '../auth/auth.guard';
import { AuditService } from './audit.service';

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

/**
 * 전역 모듈. 쓰기를 하는 모든 모듈이 AuditService를 쓰고, AuthGuard의 의존성은
 * **가드를 쓰는 컨트롤러의 모듈**에서 해석되므로 전역이 아니면 모듈마다 import해야 한다 (P0 13절 인계).
 */
@Global()
@Module({
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
