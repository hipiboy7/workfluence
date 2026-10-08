import { Controller, Get, Header } from '@nestjs/common';
import { buildOpenApi, toSortedYaml, V1_OPENAPI_INFO, V1_OPERATIONS } from '@workfluence/shared';
import { createHash } from 'node:crypto';

/**
 * 공개 API v1의 명세 (docs/spinoff/public-api 설계서 FR-2220). **인증 없이** 받는다 — 에이전트가 토큰을 쓰기 전에 무엇을 부를 수 있는지 읽어야 하고,
 * 명세에는 비밀이 없다(경로·모양·설명뿐). 그래서 `@UseV1()`을 걸지 않는다 — 토큰 가드도 빈도 제한도 없다.
 * 문서는 **경로 표에서 만든다**(`packages/shared/src/v1-spec.ts`) — 한 번 만들어 두고 같은 것을 돌려준다.
 *
 * 에이전트는 명세를 받아 처음에는 전체를, 이후에는 변동분을 읽고 도구를 만든다(스핀오프 README "왜 만드는가"). 그래서
 * - `openapi.yaml` — 키를 정렬한 YAML. 같은 코드는 늘 같은 글이라 변동분이 줄 단위로 정확하다. 저장소의 `docs/spinoff/public-api/openapi.yaml`과 같은 글이다
 * - `openapi.sha256` — 그 YAML 글의 SHA-256(16진수). 전체를 받기 전에 바뀌었는지만 먼저 본다
 * - `openapi.json` — 같은 명세의 JSON
 */
@Controller('api/v1')
export class V1OpenApiController {
  private readonly doc = buildOpenApi(V1_OPERATIONS, V1_OPENAPI_INFO);
  private readonly yamlText = toSortedYaml(this.doc);
  private readonly hash = createHash('sha256').update(this.yamlText).digest('hex');

  @Get('openapi.json')
  get(): object {
    return this.doc;
  }

  @Get('openapi.yaml')
  @Header('Content-Type', 'application/yaml; charset=utf-8')
  yaml(): string {
    return this.yamlText;
  }

  @Get('openapi.sha256')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  sha256(): string {
    return this.hash;
  }
}
