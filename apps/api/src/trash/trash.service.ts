import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, type Principal, type TrashPageView, type TrashSpaceView } from '@workfluence/shared';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { pages, spaces, users, type PageRow, type SpaceRow } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';

/**
 * 휴지통 (P4_설계서_Admin C절, FR-510~517).
 *
 * 되살리기 권한은 **그 스페이스의 쓰기 권한**을 따른다 (FR-511). 새 판정을 만들지 않는다.
 */
@Injectable()
export class TrashService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
  ) {}

  /**
   * 지운 페이지 목록.
   *
   * **권한을 질의에서 건다** — 가져와서 거르면 `limit`이 조용히 빈다 (Phase 3 FR-403과 같은 판단).
   * 지워진 스페이스의 페이지는 넣지 않는다. 그쪽은 스페이스를 먼저 되살려야 한다.
   */
  async listPages(principal: Principal, limit: number, tx: Db = this.db): Promise<TrashPageView[]> {
    const isAdmin = can(principal, 'space.manage');
    const rows = await tx.execute<{
      id: string;
      title: string;
      space_id: string;
      space_name: string;
      deleted_at: Date;
      deleted_by_name: string | null;
    }>(sql`
      SELECT p.id, p.title, s.id AS space_id, s.name AS space_name, p.deleted_at,
             u.display_name AS deleted_by_name
        FROM pages p
        JOIN spaces s ON s.id = p.space_id AND s.deleted_at IS NULL
        LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = ${principal.id}
        LEFT JOIN users u ON u.id = p.updated_by
       WHERE p.deleted_at IS NOT NULL
         AND s.status = 'active'
         AND (${isAdmin}
              OR (s.kind = 'team' AND m.role IN ('owner','editor'))
              -- 팀 스페이스의 생성자는 Crew 행이 없어도 owner로 본다 (spaceAccess가 그렇게
              -- 판정한다). 여기만 빠지면 되살릴 수는 있는데 목록에 안 보인다 (코드 리뷰 13)
              OR (s.kind = 'team' AND s.created_by = ${principal.id})
              OR (s.kind = 'personal' AND s.created_by = ${principal.id}))
       ORDER BY p.deleted_at DESC
       LIMIT ${limit}
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      title: r.title,
      spaceId: r.space_id,
      spaceName: r.space_name,
      deletedAt: new Date(r.deleted_at).toISOString(),
      deletedByName: r.deleted_by_name ?? '(알 수 없음)',
    }));
  }

  /**
   * 페이지 되살리기.
   *
   * **부모가 아직 지워져 있으면 최상위로 올린다** (FR-512). 없는 부모를 가리킨 채로 살리면
   * 트리 어디에도 안 보이는 페이지가 된다 — 되살렸는데 찾을 수 없는 상태가 가장 나쁘다.
   */
  async restorePage(id: string, principal: Principal, tx: Db = this.db): Promise<{ page: PageRow; movedToRoot: boolean }> {
    const row = await tx.query.pages.findFirst({ where: and(eq(pages.id, id), isNotNull(pages.deletedAt)) });
    if (!row) throw new NotFoundException('휴지통에서 찾을 수 없다');
    await this.spaces.assertWrite(row.spaceId, principal, tx);

    let movedToRoot = false;
    if (row.parentId) {
      const parent = await tx.query.pages.findFirst({ where: and(eq(pages.id, row.parentId), isNull(pages.deletedAt)) });
      if (!parent) movedToRoot = true;
    }
    // 최상위로 올릴 때는 **자리도 다시 잡는다.** 예전 형제들 사이의 번호를 그대로 들고 오면
    // 최상위의 다른 페이지와 번호가 겹쳐 순서가 뒤죽박죽이 된다 — "찾을 수 있게 한다"는
    // FR-512의 취지에 어긋난다 (코드 리뷰 12)
    let position = row.position;
    if (movedToRoot) {
      const [{ maxPos }] = await tx
        .select({ maxPos: sql<number>`coalesce(max(${pages.position}), -1)::int` })
        .from(pages)
        .where(and(eq(pages.spaceId, row.spaceId), isNull(pages.parentId), isNull(pages.deletedAt)));
      position = maxPos + 1;
    }
    const [next] = await tx
      .update(pages)
      .set({ deletedAt: null, parentId: movedToRoot ? null : row.parentId, position, updatedBy: principal.id, updatedAt: new Date() })
      .where(eq(pages.id, id))
      .returning();
    return { page: next, movedToRoot };
  }

  /** 지운 스페이스는 관리자만 본다 (FR-513) */
  async listSpaces(principal: Principal, limit: number, tx: Db = this.db): Promise<TrashSpaceView[]> {
    if (!can(principal, 'space.manage')) throw new ForbiddenException('스페이스 휴지통은 관리자만 본다');
    const rows = await tx
      .select({ id: spaces.id, name: spaces.name, key: spaces.key, deletedAt: spaces.deletedAt, createdByName: users.displayName })
      .from(spaces)
      .leftJoin(users, eq(users.id, spaces.createdBy))
      .where(isNotNull(spaces.deletedAt))
      .orderBy(desc(spaces.deletedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      deletedAt: r.deletedAt!.toISOString(),
      createdByName: r.createdByName ?? '(알 수 없음)',
    }));
  }

  async restoreSpace(id: string, principal: Principal, tx: Db = this.db): Promise<SpaceRow> {
    if (!can(principal, 'space.manage')) throw new ForbiddenException('스페이스 되살리기는 관리자만 한다');
    const row = await tx.query.spaces.findFirst({ where: and(eq(spaces.id, id), isNotNull(spaces.deletedAt)) });
    if (!row) throw new NotFoundException('휴지통에서 찾을 수 없다');
    // **안에 있던 페이지는 함께 다시 보인다.** 스페이스 삭제는 `spaces.deleted_at`만 건드리고
    // 페이지는 그대로 두기 때문이다 — 둘을 구분하는 것이 `pages.deleted_at`이다.
    // 따로 지운 페이지만 페이지 휴지통에 남는다 (코드 리뷰 5: 예전 주석은 정반대였다)
    const [next] = await tx.update(spaces).set({ deletedAt: null }).where(eq(spaces.id, id)).returning();
    return next;
  }
}
