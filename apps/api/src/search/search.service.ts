import { Inject, Injectable } from '@nestjs/common';
import { can, type Principal, type SearchHit } from '@workfluence/shared';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';

/**
 * 검색 (P3_설계서_Content 2절, FR-400~409).
 *
 * **권한을 질의에서 건다** (FR-403). 가져와서 거르면 `limit`이 조용히 빈다 — Phase 2의 스페이스
 * 목록이 그 실수를 했다(자체 점검 #4-b). 볼 수 없는 것은 **애초에 세어지지도 않아야 한다.**
 */
@Injectable()
export class SearchService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async search(principal: Principal, q: string, limit: number, spaceId?: string): Promise<SearchHit[]> {
    const like = `%${q}%`;
    const isAdmin = can(principal, 'space.manage');

    const rows = await this.db.execute<{
      page_id: string;
      space_id: string;
      space_name: string;
      title: string;
      snippet: string;
      updated_at: Date;
    }>(sql`
      SELECT p.id AS page_id,
             s.id AS space_id,
             s.name AS space_name,
             p.title,
             -- 찾은 자리 앞뒤를 잘라 보여 준다. 없으면 앞부분
             CASE WHEN position(lower(${q}) in lower(p.search_text)) > 0
                  THEN substring(p.search_text
                                 from greatest(position(lower(${q}) in lower(p.search_text)) - 30, 1)
                                 for 120)
                  ELSE substring(p.search_text from 1 for 120) END AS snippet,
             p.updated_at
        FROM pages p
        JOIN spaces s ON s.id = p.space_id AND s.deleted_at IS NULL
        LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = ${principal.id}
       WHERE p.deleted_at IS NULL
         AND (${isAdmin} OR m.user_id IS NOT NULL OR (s.kind = 'personal' AND s.created_by = ${principal.id}))
         ${spaceId ? sql`AND s.id = ${spaceId}` : sql``}
         AND (p.title ILIKE ${like} OR p.search_text ILIKE ${like})
       ORDER BY p.updated_at DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((r) => ({
      pageId: r.page_id,
      spaceId: r.space_id,
      spaceName: r.space_name,
      title: r.title,
      snippet: r.snippet ?? '',
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }
}
