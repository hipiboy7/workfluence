import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard } from './auth/auth.guard';
import { CommentsModule } from './comments/comments.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { APP_ENV, ConfigModule, loadEnv } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { LabelsModule } from './labels/labels.module';
import { TemplatesModule } from './templates/templates.module';
import { PagesModule } from './pages/pages.module';
import { SearchModule } from './search/search.module';
import { SettingsModule } from './settings/settings.module';
import { SpacesModule } from './spaces/spaces.module';
import { TrashModule } from './trash/trash.module';
import { UsersModule } from './users/users.module';

// SPA 정적 서빙 여부는 모듈 구성 시점에 알아야 하므로 같은 로더를 한 번 더 호출한다 (순수 함수라 결과가 같다)
const env = loadEnv();

/**
 * SPA 산출물 경로를 풀고 **없으면 기동을 멈춘다.**
 *
 * 경로가 틀리면 화면은 통째로 404인데 `/api/health`는 200이라 **헬스체크가 healthy를 보고한다.**
 * 조용히 잘못되는 유형이라 기동 시점에 시끄럽게 실패시킨다.
 * (컨테이너에서 `WF_WEB_DIST=../../web/dist`로 잘못 두었던 적이 있다 — P0 검토서 참고)
 */
function resolveWebDist(): string {
  const rootPath = resolve(__dirname, '..', env.WF_WEB_DIST);
  if (!existsSync(rootPath)) {
    throw new Error(
      `WF_SERVE_WEB=true인데 SPA 산출물이 없다: ${rootPath}\n` +
        `  WF_WEB_DIST=${env.WF_WEB_DIST} (기준 ${resolve(__dirname, '..')})\n` +
        `  개발이면 'pnpm build'를, 컨테이너면 이미지 레이아웃과 WF_WEB_DIST를 확인한다.`,
    );
  }
  return rootPath;
}

@Module({
  imports: [
    ConfigModule,
    DbModule,
    // AuditModule은 @Global — 쓰기를 하는 모든 모듈이 AuditService를 쓴다
    AuditModule,
    UsersModule,
    AuthModule,
    // SpacesModule은 @Global — PagesService와 승인 시 개인 스페이스 생성이 쓴다
    SpacesModule,
    PagesModule,
    SearchModule,
    // SettingsModule은 @Global — 정책값을 쓰는 모든 모듈이 읽는다
    SettingsModule,
    AttachmentsModule,
    // MailModule은 @Global — 알림을 만드는 곳이 커밋 뒤에 메일도 보낸다 (FR-754)
    MailModule,
    // NotificationsModule은 @Global — 댓글·페이지 저장이 멘션 알림을 만든다
    NotificationsModule,
    CommentsModule,
    TrashModule,
    LabelsModule,
    TemplatesModule,
    ...(env.WF_SERVE_WEB
      ? [
          ServeStaticModule.forRoot({
            rootPath: resolveWebDist(),
            exclude: ['/api/{*splat}'],
            serveStaticOptions: {
              // 해시 파일명 자산만 immutable, 나머지는 no-store (CLAUDE.md 7절)
              // Vite 산출물: assets/<name>-<8자 이상 base64url 해시>.<ext>
              setHeaders: (res, path) => {
                if (/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path)) {
                  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                } else {
                  res.setHeader('Cache-Control', 'no-store');
                }
              },
            },
          }),
        ]
      : []),
  ],
  controllers: [HealthController],
  // CSRF는 전역이다 (FR-240). 핸들러마다 붙이면 새 엔드포인트에서 빠뜨린다
  providers: [{ provide: APP_GUARD, useClass: CsrfGuard }],
})
export class AppModule {}

export { APP_ENV };
