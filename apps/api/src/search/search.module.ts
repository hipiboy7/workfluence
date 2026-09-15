import { Controller, Get, Inject, Injectable, Module, Query, UseGuards } from '@nestjs/common';
import { searchQueryDto, type SearchHit, type SearchQueryDto } from '@workfluence/shared';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { AuthGuard, RequireAction } from '../auth/auth.guard';
import { AuthModule } from '../auth/auth.module';
import { ZodPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { pages, spaces } from '../db/schema';

/**
 * 한글 부분 일치 검색 (프로토타입). pages.search_text·title에 ILIKE + pg_trgm GIN 인덱스.
 * 2글자 질의의 인덱스 활용 여부와 지연은 Phase 3에서 실측한다 (CLAUDE.md 보류 2).
 */
@Injectable()
export class SearchService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async search(q: SearchQueryDto): Promise<SearchHit[]> {
    const pattern = `%${escapeLike(q.q)}%`;
    const rows = await this.db
      .select({
        pageId: pages.id,
        spaceId: pages.spaceId,
        spaceKey: spaces.key,
        title: pages.title,
        searchText: pages.searchText,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(
        and(
          isNull(pages.deletedAt),
          isNull(spaces.deletedAt),
          q.spaceId ? eq(pages.spaceId, q.spaceId) : undefined,
          or(ilike(pages.title, pattern), ilike(pages.searchText, pattern)),
        ),
      )
      .orderBy(desc(sql`(${pages.title} ilike ${pattern})`), desc(pages.updatedAt))
      .limit(q.limit);
    return rows.map((r) => ({
      pageId: r.pageId,
      spaceId: r.spaceId,
      spaceKey: r.spaceKey,
      title: r.title,
      snippet: makeSnippet(r.searchText, q.q),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function makeSnippet(text: string, q: string, radius = 60): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2).replace(/\s+/g, ' ');
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

@Controller('api/search')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @RequireAction('page.read')
  search(@Query(new ZodPipe(searchQueryDto)) q: SearchQueryDto): Promise<SearchHit[]> {
    return this.svc.search(q);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
