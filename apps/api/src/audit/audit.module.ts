import { Controller, Get, Global, Module, Query, UseGuards } from '@nestjs/common';
import { auditQueryDto, type AuditEventView, type AuditQueryDto } from '@workfluence/shared';
import { ZodPipe } from '../common/zod.pipe';
import { AuthGuard, RequireAction } from '../auth/auth.guard';
import { AuditService } from './audit.service';

@Controller('api/audit')
@UseGuards(AuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireAction('audit.read')
  list(@Query(new ZodPipe(auditQueryDto)) q: AuditQueryDto): Promise<AuditEventView[]> {
    // 매직 넘버 대신 shared의 계약을 쓴다 (CLAUDE.md 5절·7절). UsersController와 같은 스키마다
    return this.audit.list(q);
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
