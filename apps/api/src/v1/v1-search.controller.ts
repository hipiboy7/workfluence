import { Controller, Get, Inject, Query } from '@nestjs/common';
import { v1SearchQuery, type SearchHit, type V1SearchQuery } from '@workfluence/shared';
import { CurrentUser, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { SEARCH, type SearchProvider } from '../search/search.service';
import { SpacesService } from '../spaces/spaces.service';
import { resolveSpaceRef } from './space-ref';
import { UseV1 } from './use-v1';

/**
 * 공개 API v1 — 검색 (docs/spinoff/public-api 설계서 3.5절). 에이전트가 정하는 것은 **검색어뿐**이다 — 스페이스로 좁히는 것은 이름으로도 된다. 권한 거름
 * (볼 수 없는 스페이스·휴지통)은 검색 서비스 한 곳이 한다. 검색은 읽기라 감사로그에 남기지 않는다(FR-409)
 */
@Controller('api/v1/search')
@UseV1()
export class V1SearchController {
  constructor(
    @Inject(SEARCH) private readonly search: SearchProvider,
    private readonly spaces: SpacesService,
  ) {}

  @Get()
  async find(@Query(new ZodPipe(v1SearchQuery)) q: V1SearchQuery, @CurrentUser() me: SessionUser): Promise<{ items: SearchHit[] }> {
    // 이름으로 좁히면 **없는 이름은 404**다 — 빈 결과로 얼버무리면 에이전트가 "없다"로 잘못 읽는다
    const spaceId = q.space ? (await resolveSpaceRef(this.spaces, q.space, me)).id : undefined;
    return { items: await this.search.search(me, q.q, q.limit, spaceId) };
  }
}
