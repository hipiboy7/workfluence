import { applyDecorators, UseFilters, UseGuards } from '@nestjs/common';
import { ApiRateLimitGuard } from '../api-tokens/api-rate-limit.guard';
import { ApiTokenGuard } from '../api-tokens/api-token.guard';
import { V1ExceptionFilter } from './v1-error.filter';

/**
 * 공개 API(v1) 컨트롤러가 늘 함께 거는 셋 — 토큰 가드(scope·사람의 권한) → 토큰별 빈도 제한 → 오류를 한 모양으로. **순서가 뜻이 있다**: 인증을 통과한
 * 요청만 센다. 모듈마다 따로 적으면 하나를 빠뜨린 모듈이 생긴다 — 여기 한 곳에 둔다 (docs/spinoff/public-api 설계서 FR-2211·2213)
 */
export const UseV1 = () => applyDecorators(UseGuards(ApiTokenGuard, ApiRateLimitGuard), UseFilters(V1ExceptionFilter));
