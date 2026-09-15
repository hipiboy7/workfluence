import { Body, Controller, Get, Global, Inject, Injectable, Ip, Module, Put, UseGuards } from '@nestjs/common';
import { SETTINGS_KEYS, contactSettingsDto, type ContactSettingsDto } from '@workfluence/shared';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.module';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { settings } from '../db/schema';

/** 운영 조절값 저장소 (CLAUDE.md 5절 세 번째 분류). 프로토타입은 담당자 안내문 하나 */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db.query.settings.findFirst({ where: eq(settings.key, key) });
    return row ? (row.value as T) : fallback;
  }

  async set(key: string, value: unknown, actor: SessionUser, ip: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value: value as object, updatedBy: actor.id })
      .onConflictDoUpdate({ target: settings.key, set: { value: value as object, updatedBy: actor.id, updatedAt: sql`now()` } });
    await this.audit.record({ action: 'settings.update', actorId: actor.id, targetType: 'setting', targetId: key, ip });
  }
}

@Controller('api/settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}

  @Get('contact')
  @RequireAction('settings.manage')
  async getContact(): Promise<{ message: string }> {
    return { message: await this.svc.get<string>(SETTINGS_KEYS.contactInfo, '') };
  }

  @Put('contact')
  @RequireAction('settings.manage')
  async setContact(@Body(new ZodPipe(contactSettingsDto)) dto: ContactSettingsDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<{ message: string }> {
    await this.svc.set(SETTINGS_KEYS.contactInfo, dto.message, actor, ip);
    return { message: dto.message };
  }
}

@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
