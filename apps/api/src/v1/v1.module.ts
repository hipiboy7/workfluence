import { Module } from '@nestjs/common';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { PagesModule } from '../pages/pages.module';
import { V1PagesController } from './v1-pages.controller';
import { V1CategoriesController, V1SpacesController } from './v1-spaces.controller';

/**
 * 공개 API v1 (`/api/v1`, docs/spinoff/public-api 설계서). 컨트롤러는 화면용과 같은 유스케이스를 부르는 얇은 층이다 — 규칙을 두 곳에 두지 않는다.
 * 인증은 토큰(`ApiTokenGuard`)이다. 모듈을 하나씩 더해 간다 — 지금은 페이지·스페이스·분류
 */
@Module({
  imports: [PagesModule, ApiTokensModule],
  controllers: [V1PagesController, V1SpacesController, V1CategoriesController],
})
export class V1Module {}
