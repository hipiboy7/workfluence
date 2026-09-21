import { Controller, Get, Global, Module, Query, UseGuards } from '@nestjs/common';
import { searchQueryDto, type SearchHit } from '@workfluence/shared';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { SearchService } from './search.service';

@Controller('api/search')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** 검색은 읽기다. **감사로그에 남기지 않는다** (FR-409) — 기록이 검색량만큼 불어난다 */
  @Get()
  find(
    @Query(new ZodPipe(searchQueryDto)) q: ReturnType<typeof searchQueryDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<SearchHit[]> {
    return this.search.search(me, q.q, q.limit, q.spaceId);
  }
}

@Global()
@Module({ providers: [SearchService], controllers: [SearchController], exports: [SearchService] })
export class SearchModule {}
