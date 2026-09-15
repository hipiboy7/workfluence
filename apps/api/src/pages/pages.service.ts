import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PAGE_TREE_MAX_DEPTH,
  extractText,
  type CreatePageDto,
  type DocNode,
  type MovePageDto,
  type PageSummary,
  type PageVersionView,
  type PageView,
  type Principal,
  type UpdatePageDto,
} from '@workfluence/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.module';
import type { SessionUser } from '../auth/auth.guard';
import { DB, type Db } from '../db/db.module';
import { pageVersions, pages, users, type PageRow } from '../db/schema';
import { SpacesService } from '../spaces/spaces.module';
import { toPageSummary } from './page-view';

export { toPageSummary };

/**
 * 페이지·버전 (CLAUDE.md 6절).
 * - page_versions는 append-only. 수정·복원은 항상 새 버전을 만들고 pages.current_version_no만 옮긴다.
 * - 저장 시 baseVersionNo가 현재 버전과 다르면 409 — 다른 사람이 먼저 저장한 것을 덮어쓰지 않는다.
 * - 트랜잭션 안에서 페이지 행을 FOR UPDATE로 잠가 동시 저장의 버전 번호 충돌을 막는다.
 * - 읽기·쓰기 권한은 스페이스 접근 판정(SpacesService.context / assertWrite)을 따른다.
 */
@Injectable()
export class PagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly spaces: SpacesService,
  ) {}

  private async getRowOrThrow(id: string, tx: Db = this.db): Promise<PageRow> {
    const row = await tx.query.pages.findFirst({ where: and(eq(pages.id, id), isNull(pages.deletedAt)) });
    if (!row) throw new NotFoundException('페이지를 찾을 수 없다');
    return row;
  }

  private async readable(id: string, principal: Principal): Promise<PageRow> {
    const page = await this.getRowOrThrow(id);
    await this.spaces.context(page.spaceId, principal);
    return page;
  }

  async get(id: string, principal: Principal): Promise<PageView> {
    const page = await this.readable(id, principal);
    const version = await this.db.query.pageVersions.findFirst({
      where: and(eq(pageVersions.pageId, id), eq(pageVersions.versionNo, page.currentVersionNo)),
    });
    if (!version) throw new NotFoundException('현재 버전을 찾을 수 없다');
    return {
      ...toPageSummary(page),
      content: version.contentJson as DocNode,
      createdBy: page.createdBy,
      updatedBy: page.updatedBy,
      createdAt: page.createdAt.toISOString(),
    };
  }

  async create(dto: CreatePageDto, actor: SessionUser, ip: string): Promise<PageView> {
    await this.spaces.assertWrite(dto.spaceId, actor);
    return this.db.transaction(async (tx) => {
      if (dto.parentId) await this.assertParent(tx, dto.parentId, dto.spaceId, null);

      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${pages.position}), -1) + 1` })
        .from(pages)
        .where(and(eq(pages.spaceId, dto.spaceId), dto.parentId ? eq(pages.parentId, dto.parentId) : isNull(pages.parentId), isNull(pages.deletedAt)));

      const text = extractText(dto.content);
      const [page] = await tx
        .insert(pages)
        .values({
          spaceId: dto.spaceId,
          parentId: dto.parentId,
          title: dto.title,
          position: Number(next),
          currentVersionNo: 1,
          searchText: text,
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returning();
      await tx.insert(pageVersions).values({ pageId: page.id, versionNo: 1, title: dto.title, contentJson: dto.content, contentText: text, createdBy: actor.id });
      await this.audit.record(
        { action: 'page.create', actorId: actor.id, targetType: 'page', targetId: page.id, detail: { spaceId: dto.spaceId, title: dto.title }, ip },
        tx,
      );
      return { ...toPageSummary(page), content: dto.content, createdBy: actor.id, updatedBy: actor.id, createdAt: page.createdAt.toISOString() };
    });
  }

  async update(id: string, dto: UpdatePageDto, actor: SessionUser, ip: string): Promise<PageView> {
    const current = await this.getRowOrThrow(id);
    await this.spaces.assertWrite(current.spaceId, actor);
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(pages).where(and(eq(pages.id, id), isNull(pages.deletedAt))).for('update');
      if (!locked) throw new NotFoundException('페이지를 찾을 수 없다');
      if (locked.currentVersionNo !== dto.baseVersionNo) {
        throw new ConflictException({
          message: '다른 사용자가 먼저 저장했다. 최신 버전을 불러와 다시 편집해야 한다',
          currentVersionNo: locked.currentVersionNo,
          baseVersionNo: dto.baseVersionNo,
        });
      }
      const page = await this.appendVersion(tx, locked, dto.title, dto.content, actor);
      await this.audit.record({ action: 'page.update', actorId: actor.id, targetType: 'page', targetId: id, detail: { versionNo: page.currentVersionNo }, ip }, tx);
      return { ...toPageSummary(page), content: dto.content, createdBy: page.createdBy, updatedBy: actor.id, createdAt: page.createdAt.toISOString() };
    });
  }

  private async appendVersion(tx: Db, locked: PageRow, title: string, content: DocNode, actor: SessionUser): Promise<PageRow> {
    const nextNo = locked.currentVersionNo + 1;
    const text = extractText(content);
    await tx.insert(pageVersions).values({ pageId: locked.id, versionNo: nextNo, title, contentJson: content, contentText: text, createdBy: actor.id });
    const [page] = await tx
      .update(pages)
      .set({ title, currentVersionNo: nextNo, searchText: text, updatedBy: actor.id, updatedAt: sql`now()` })
      .where(eq(pages.id, locked.id))
      .returning();
    return page;
  }

  async versions(id: string, principal: Principal): Promise<PageVersionView[]> {
    await this.readable(id, principal);
    const rows = await this.db
      .select({
        versionNo: pageVersions.versionNo,
        title: pageVersions.title,
        createdBy: pageVersions.createdBy,
        createdByName: users.displayName,
        createdAt: pageVersions.createdAt,
      })
      .from(pageVersions)
      .innerJoin(users, eq(users.id, pageVersions.createdBy))
      .where(eq(pageVersions.pageId, id))
      .orderBy(desc(pageVersions.versionNo));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  async version(id: string, versionNo: number, principal: Principal): Promise<PageVersionView & { content: DocNode }> {
    await this.readable(id, principal);
    const row = await this.db
      .select({
        versionNo: pageVersions.versionNo,
        title: pageVersions.title,
        createdBy: pageVersions.createdBy,
        createdByName: users.displayName,
        createdAt: pageVersions.createdAt,
        content: pageVersions.contentJson,
      })
      .from(pageVersions)
      .innerJoin(users, eq(users.id, pageVersions.createdBy))
      .where(and(eq(pageVersions.pageId, id), eq(pageVersions.versionNo, versionNo)))
      .then((r) => r[0]);
    if (!row) throw new NotFoundException('버전을 찾을 수 없다');
    return { ...row, content: row.content as DocNode, createdAt: row.createdAt.toISOString() };
  }

  /** 과거 버전 복원 = 그 내용으로 새 버전을 만든다. 이력은 지워지지 않는다. */
  async restoreVersion(id: string, versionNo: number, actor: SessionUser, ip: string): Promise<PageView> {
    const current = await this.getRowOrThrow(id);
    await this.spaces.assertWrite(current.spaceId, actor);
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(pages).where(and(eq(pages.id, id), isNull(pages.deletedAt))).for('update');
      if (!locked) throw new NotFoundException('페이지를 찾을 수 없다');
      const old = await tx.query.pageVersions.findFirst({ where: and(eq(pageVersions.pageId, id), eq(pageVersions.versionNo, versionNo)) });
      if (!old) throw new NotFoundException('버전을 찾을 수 없다');
      const content = old.contentJson as DocNode;
      const page = await this.appendVersion(tx, locked, old.title, content, actor);
      await this.audit.record(
        { action: 'page.version.restore', actorId: actor.id, targetType: 'page', targetId: id, detail: { from: versionNo, to: page.currentVersionNo }, ip },
        tx,
      );
      return { ...toPageSummary(page), content, createdBy: page.createdBy, updatedBy: actor.id, createdAt: page.createdAt.toISOString() };
    });
  }

  async move(id: string, dto: MovePageDto, actor: SessionUser, ip: string): Promise<PageSummary> {
    const current = await this.getRowOrThrow(id);
    await this.spaces.assertWrite(current.spaceId, actor);
    return this.db.transaction(async (tx) => {
      const page = await this.getRowOrThrow(id, tx);
      if (dto.parentId) await this.assertParent(tx, dto.parentId, page.spaceId, id);
      const [row] = await tx
        .update(pages)
        .set({ parentId: dto.parentId, position: dto.position, updatedBy: actor.id, updatedAt: sql`now()` })
        .where(eq(pages.id, id))
        .returning();
      await this.audit.record({ action: 'page.move', actorId: actor.id, targetType: 'page', targetId: id, detail: dto, ip }, tx);
      return toPageSummary(row);
    });
  }

  async softDelete(id: string, actor: SessionUser, ip: string): Promise<void> {
    const current = await this.getRowOrThrow(id);
    await this.spaces.assertWrite(current.spaceId, actor);
    await this.db.transaction(async (tx) => {
      const page = await this.getRowOrThrow(id, tx);
      const children = await tx.select({ id: pages.id }).from(pages).where(and(eq(pages.parentId, id), isNull(pages.deletedAt)));
      if (children.length) throw new BadRequestException('하위 페이지가 있는 페이지는 삭제할 수 없다. 하위를 먼저 옮기거나 삭제한다');
      await tx.update(pages).set({ deletedAt: sql`now()`, updatedBy: actor.id, updatedAt: sql`now()` }).where(eq(pages.id, id));
      await this.audit.record({ action: 'page.delete', actorId: actor.id, targetType: 'page', targetId: id, detail: { title: page.title }, ip }, tx);
    });
  }

  /** 부모가 같은 스페이스의 살아 있는 페이지인지, 자기 자신·자손이 아닌지, 깊이 한도 안인지 확인 */
  private async assertParent(tx: Db, parentId: string, spaceId: string, selfId: string | null): Promise<void> {
    let cursor: string | null = parentId;
    let depth = 0;
    while (cursor) {
      if (cursor === selfId) throw new BadRequestException('페이지를 자기 자신이나 자손 아래로 옮길 수 없다');
      const row: PageRow | undefined = await tx.query.pages.findFirst({ where: and(eq(pages.id, cursor), isNull(pages.deletedAt)) });
      if (!row) throw new NotFoundException('부모 페이지를 찾을 수 없다');
      if (row.spaceId !== spaceId) throw new BadRequestException('다른 스페이스의 페이지를 부모로 둘 수 없다');
      cursor = row.parentId;
      if (++depth > PAGE_TREE_MAX_DEPTH) throw new BadRequestException(`페이지 트리 깊이는 ${PAGE_TREE_MAX_DEPTH}를 넘을 수 없다`);
    }
  }

  /** 검색 인덱스(search_text) 재생성 — 파생 데이터는 언제든 다시 만들 수 있어야 한다 (CLAUDE.md 6절) */
  async reindexAll(): Promise<number> {
    const rows = await this.db
      .select({ id: pages.id, content: pageVersions.contentJson })
      .from(pages)
      .innerJoin(pageVersions, and(eq(pageVersions.pageId, pages.id), eq(pageVersions.versionNo, pages.currentVersionNo)))
      .where(isNull(pages.deletedAt))
      .orderBy(asc(pages.createdAt));
    for (const r of rows) {
      await this.db.update(pages).set({ searchText: extractText(r.content as DocNode) }).where(eq(pages.id, r.id));
    }
    return rows.length;
  }
}
