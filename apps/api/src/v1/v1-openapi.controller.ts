import { Controller, Get } from '@nestjs/common';
import { buildOpenApi, V1_OPENAPI_INFO, V1_OPERATIONS } from '@workfluence/shared';

/**
 * 공개 API v1의 명세 (docs/spinoff/public-api 설계서 FR-2220). **인증 없이** 받는다 — 에이전트가 토큰을 쓰기 전에 무엇을 부를 수 있는지 읽어야 하고,
 * 명세에는 비밀이 없다(경로·모양·설명뿐). 그래서 `@UseV1()`을 걸지 않는다 — 토큰 가드도 빈도 제한도 없다.
 * 문서는 **경로 표에서 만든다**(`packages/shared/src/v1-spec.ts`) — 한 번 만들어 두고 같은 것을 돌려준다.
 */
@Controller('api/v1/openapi.json')
export class V1OpenApiController {
  private readonly doc = buildOpenApi(V1_OPERATIONS, V1_OPENAPI_INFO);

  @Get()
  get(): object {
    return this.doc;
  }
}
