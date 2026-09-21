import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, type LabelView, type Principal, type SearchHit } from '@workfluence/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { labels, pageLabels, pages } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';

/**
 * 라벨 (P4_설계서_Admin C절, FR-533~536).
 *
 * Phase 3이 테이블만 만들고 호출부를 두지 않았다 — 보류 10("호출자 없는 코드의 커버리지는
 * 품질 근거가 아니다")의 대상이었다. 여기서 호출부가 붙으면서 그 항목이 닫힌다.
 *
 * 권한은 **그 페이지의 스페이스 판정**을 따른다 (FR-535). 라벨 자체에는 권한이 없다.
 */
@Injectable()
export class LabelsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
  ) {}

  private async page(pageId: string, tx: Db) {
    const row = await tx.query.pages.findFirst({ where: and(eq(pages.id, pageId), isNull(pages.deletedAt)) });
    if (!row) throw new NotFoundException('페이지를 찾을 수 없다');
    return row;
  }

  /** 라벨 이름은 유일하다 (FR-425). 같은 이름을 다시 붙이면 **새로 만들지 않고 그것을 쓴다** */
  private async ensure(name: string, tx: Db): Promise<string> {
    const normalized = name.trim().toLowerCase();
    if (!normalized) throw new BadRequestException('라벨 이름이 비어 있다');
    const found = await tx.query.labels.findFirst({ where: eq(labels.name, normalized) });
    if (found) return found.id;
    const [created] = await tx.insert(labels).values({ name: normalized }).returning();
    return created.id;
  }

  async forPage(pageId: string, principal: Principal, tx: Db = this.db): Promise<LabelView[]> {
    const page = await this.page(pageId, tx);
    await this.spaces.context(page.spaceId, principal, tx); // 못 보면 404
    const rows = await tx
      .select({ id: labels.id, name: labels.name })
      .from(pageLabels)
      .innerJoin(labels, eq(labels.id, pageLabels.labelId))
      .where(eq(pageLabels.pageId, pageId))
      .orderBy(asc(labels.name));
    return rows;
  }

  async attach(pageId: string, name: string, principal: Principal, tx: Db = this.db): Promise<LabelView> {
    const page = await this.page(pageId, tx);
    await this.spaces.assertWrite(page.spaceId, principal, tx);
    const labelId = await this.ensure(name, tx);
    // 이미 붙어 있으면 조용히 넘어간다 — 두 번 눌렀다고 오류를 보일 일이 아니다
    await tx.insert(pageLabels).values({ pageId, labelId }).onConflictDoNothing();
    const row = await tx.query.labels.findFirst({ where: eq(labels.id, labelId) });
    return { id: row!.id, name: row!.name };
  }

  async detach(pageId: string, labelId: string, principal: Principal, tx: Db = this.db): Promise<void> {
    const page = await this.page(pageId, tx);
    await this.spaces.assertWrite(page.spaceId, principal, tx);
    await tx.delete(pageLabels).where(and(eq(pageLabels.pageId, pageId), eq(pageLabels.labelId, labelId)));
    // **쓰는 곳이 없어진 라벨은 지운다.** 안 그러면 자동완성 목록이 쓰레기로 찬다
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(pageLabels)
      .where(eq(pageLabels.labelId, labelId));
    if (n === 0) await tx.delete(labels).where(eq(labels.id, labelId));
  }

  /** 라벨로 페이지 찾기 (FR-534). **권한을 질의에서 건다** — 검색과 같은 판단이다 */
  async findPages(name: string, principal: Principal, limit: number, tx: Db = this.db): Promise<SearchHit[]> {
    const isAdmin = can(principal, 'space.manage');
    const rows = await tx.execute<{ page_id: string; space_id: string; space_name: string; title: string; updated_at: Date }>(sql`
      SELECT p.id AS page_id, s.id AS space_id, s.name AS space_name, p.title, p.updated_at
        FROM page_labels pl
        JOIN labels l ON l.id = pl.label_id AND l.name = ${name.trim().toLowerCase()}
        JOIN pages p ON p.id = pl.page_id AND p.deleted_at IS NULL
        JOIN spaces s ON s.id = p.space_id AND s.deleted_at IS NULL
        LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = ${principal.id}
       WHERE (${isAdmin} OR m.user_id IS NOT NULL OR (s.kind = 'personal' AND s.created_by = ${principal.id}))
       ORDER BY p.updated_at DESC
       LIMIT ${limit}
    `);
    return rows.rows.map((r) => ({
      pageId: r.page_id,
      spaceId: r.space_id,
      spaceName: r.space_name,
      title: r.title,
      snippet: '',
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  /** 자동완성용 전체 목록. 라벨 이름 자체는 비밀이 아니다 — 어느 페이지에 붙었는지가 비밀이다 */
  async all(limit: number, tx: Db = this.db): Promise<LabelView[]> {
    return tx.select({ id: labels.id, name: labels.name }).from(labels).orderBy(asc(labels.name)).limit(limit);
  }
}
