import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { CommentsModule } from '../comments/comments.module';
import { LabelsModule } from '../labels/labels.module';
import { TemplatesModule } from '../templates/templates.module';
import { TrashModule } from '../trash/trash.module';
import { PagesModule } from '../pages/pages.module';
import { V1PathExceptionFilter } from './v1-error.filter';
import { V1AuditController, V1PolicyController, V1UsersController } from './v1-admin.controller';
import { V1AttachmentsController, V1CommentsController, V1LabelsController } from './v1-content.controller';
import { V1NotificationsController, V1TemplatesController, V1TrashController } from './v1-misc.controller';
import { V1SearchController } from './v1-search.controller';
import { V1PagesController } from './v1-pages.controller';
import { V1CategoriesController, V1SpacesController } from './v1-spaces.controller';

/**
 * 공개 API v1 (`/api/v1`, docs/spinoff/public-api 설계서). 컨트롤러는 화면용과 같은 유스케이스를 부르는 얇은 층이다 — 규칙을 두 곳에 두지 않는다.
 * 인증은 토큰(`ApiTokenGuard`)이다. 모듈을 하나씩 더해 간다 — 지금은 페이지·스페이스·분류·댓글·라벨·첨부·검색·템플릿·휴지통·알림·관리(사용자·정책·감사)
 */
@Module({
  imports: [PagesModule, ApiTokensModule, CommentsModule, LabelsModule, AttachmentsModule, TemplatesModule, TrashModule],
  // 라우팅 전의 오류(잘못된 JSON·너무 큰 본문)도 /api/v1에서는 한 모양으로 — 전역 필터 (FR-2211)
  providers: [{ provide: APP_FILTER, useClass: V1PathExceptionFilter }],
  controllers: [V1PagesController, V1SpacesController, V1CategoriesController, V1CommentsController, V1LabelsController, V1AttachmentsController, V1SearchController, V1TemplatesController, V1TrashController, V1NotificationsController, V1UsersController, V1PolicyController, V1AuditController],
})
export class V1Module {}
