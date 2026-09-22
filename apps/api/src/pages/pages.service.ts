import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PAGE_TREE_MAX_DEPTH,
  diffDocs,
  extractText,
  renderExportDocument,
  stampSchemaVersion,
  type CreatePageDto,
  type DocNode,
  type MovePageDto,
  type PageSummary,
  type PageDiffView,
  type PageVersionView,
  type PageView,
  type Principal,
  type UpdatePageDto,
} from '@workfluence/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import type { MentionOutcome } from '../notifications/notifications.service';
import { REINDEX_SELECT_SQL, reindexRows, type ReindexRow } from './reindex';
import { pageVersions, pages, spaces, users, type PageRow } from '../db/schema';
import { NotificationsService } from '../notifications/notifications.service';
import { SpacesService } from '../spaces/spaces.service';
import { checkMove, type TreeNode } from './domain/tree';

/**
 * 페이지·버전 (P2_설계서_Page 3절). B등급 — 실제 PostgreSQL로 통합 테스트한다.
 *
 * - `page_versions`는 **append-only**. 수정도 복원도 새 버전이고 `current_version_no`만 옮긴다
 * - 저장 시 `baseVersionNo`가 현재와 다르면 409 (FR-322)
 * - 동시 저장은 페이지 행 `FOR UPDATE`로 줄을 세운다 (FR-323). 409 검사만으로는 경합에 뚫린다
 * - 읽기·쓰기 권한은 그 페이지가 속한 스페이스의 판정을 따른다 (FR-331)
 */

export function toPageSummary(p: PageRow): PageSummary {
  return {
    id: p.id,
    spaceId: p.spaceId,
    parentId: p.parentId,
    title: p.title,
    position: p.position,
    currentVersionNo: p.currentVersionNo,
    updatedAt: p.updatedAt.toISOString(),
  };
}

@Injectable()
export class PagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly notifications: NotificationsService,
  ) {}

  private async row(id: string, tx: Db = this.db): Promise<PageRow> {
    const p = await tx.query.pages.findFirst({ where: and(eq(pages.id, id), isNull(pages.deletedAt)) });
    if (!p) throw new NotFoundException('페이지를 찾을 수 없다');
    return p;
  }

  private async readable(id: string, principal: Principal): Promise<PageRow> {
    const page = await this.row(id);
    await this.spaces.context(page.spaceId, principal); // 볼 수 없으면 여기서 404
    return page;
  }

  /** 스페이스의 페이지 트리 (삭제된 것은 빠진다 — FR-330) */
  async tree(spaceId: string, principal: Principal): Promise<PageSummary[]> {
    await this.spaces.context(spaceId, principal);
    const rows = await this.db
      .select()
      .from(pages)
      .where(and(eq(pages.spaceId, spaceId), isNull(pages.deletedAt)))
      .orderBy(asc(pages.position), asc(pages.createdAt));
    return rows.map(toPageSummary);
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

  async create(dto: CreatePageDto, principal: Principal, tx: Db = this.db): Promise<PageView> {
    await this.spaces.assertWrite(dto.spaceId, principal, tx);
    if (dto.parentId) await this.assertParent(tx, dto.parentId, dto.spaceId, null);

    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${pages.position}), -1) + 1` })
      .from(pages)
      .where(
        and(
          eq(pages.spaceId, dto.spaceId),
          dto.parentId ? eq(pages.parentId, dto.parentId) : isNull(pages.parentId),
          isNull(pages.deletedAt),
        ),
      );

    const text = extractText(dto.content);
    // 저장 직전에 버전을 찍는다. 편집기는 이 값을 만들지 않는다 (shared의 stampSchemaVersion 주석)
    const content = stampSchemaVersion(dto.content);
    const [page] = await tx
      .insert(pages)
      .values({
        spaceId: dto.spaceId,
        parentId: dto.parentId,
        title: dto.title,
        position: Number(next),
        currentVersionNo: 1,
        searchText: text,
        createdBy: principal.id,
        updatedBy: principal.id,
      })
      .returning();
    await tx
      .insert(pageVersions)
      .values({ pageId: page.id, versionNo: 1, title: dto.title, contentJson: content, contentText: text, createdBy: principal.id });
    // 본문의 멘션도 알림을 만든다 (FR-500 — 설계서는 "댓글·페이지 본문 둘 다"다).
    // 자체 점검 1이 여기 호출부가 빠진 것을 잡았다 — 오류 없이 조용히 아무 일도 안 했다
    await this.notifications.notifyMentions(
      { doc: content, pageId: page.id, commentId: null, spaceId: page.spaceId, actorId: principal.id },
      tx,
    );
    return { ...toPageSummary(page), content, createdBy: principal.id, updatedBy: principal.id, createdAt: page.createdAt.toISOString() };
  }

  /** 저장 (FR-322, FR-323). 호출부가 트랜잭션을 준다 — 감사 기록과 같은 트랜잭션이어야 한다 */
  async update(id: string, dto: UpdatePageDto, principal: Principal, tx: Db, onMentions?: (m: MentionOutcome) => void): Promise<PageView> {
    const current = await this.row(id, tx);
    await this.spaces.assertWrite(current.spaceId, principal, tx);

    // 같은 페이지의 동시 저장을 줄 세운다. 이것이 없으면 둘 다 409 검사를 통과하고
    // 같은 version_no를 쓰려다 unique 위반으로 죽는다
    const [locked] = await tx.select().from(pages).where(and(eq(pages.id, id), isNull(pages.deletedAt))).for('update');
    if (!locked) throw new NotFoundException('페이지를 찾을 수 없다');
    if (locked.currentVersionNo !== dto.baseVersionNo) {
      throw new ConflictException({
        message: '다른 사용자가 먼저 저장했다. 최신 버전을 불러와 다시 편집해야 한다',
        currentVersionNo: locked.currentVersionNo,
        baseVersionNo: dto.baseVersionNo,
      });
    }
    // 응답은 **저장된 것과 같아야 한다.** dto.content를 그대로 돌려주면 버전이 찍히기 전 모양이
    // 나가고, 클라이언트가 그것을 다음 저장의 기준으로 쓴다
    const content = stampSchemaVersion(dto.content);
    // 직전 내용을 **버전을 더하기 전에** 읽는다. 알림은 그 둘의 차이로 만든다
    const previous = await tx.query.pageVersions.findFirst({
      where: and(eq(pageVersions.pageId, id), eq(pageVersions.versionNo, locked.currentVersionNo)),
    });
    const page = await this.appendVersion(tx, locked, dto.title, content, principal.id);
    // 본문의 멘션도 알림을 만든다 (FR-500 — 설계서는 "댓글·페이지 본문 둘 다"다).
    // 자체 점검 1이 여기 호출부가 빠진 것을 잡았다 — 오류 없이 조용히 아무 일도 안 했다.
    // **직전 내용을 함께 넘겨 새로 생긴 멘션만 부른다** (코드 리뷰 6)
    // **부른 사람들을 호출부에 넘긴다.** 메일은 커밋 뒤에 보내야 한다 (FR-754) —
    // 여기서 보내면 트랜잭션이 남의 서버를 기다리고, 롤백되면 없던 일에 대한 메일이 나간다
    const mentions = await this.notifications.notifyMentions(
      {
        doc: content,
        pageId: page.id,
        commentId: null,
        spaceId: page.spaceId,
        actorId: principal.id,
        previousDoc: (previous?.contentJson as DocNode | undefined) ?? null,
      },
      tx,
    );
    onMentions?.(mentions);
    return { ...toPageSummary(page), content, createdBy: page.createdBy, updatedBy: principal.id, createdAt: page.createdAt.toISOString() };
  }

  /**
   * 실시간 편집의 자동 저장 (P6_설계서_Collab FR-706·712).
   *
   * **권한을 다시 보지 않는다.** WebSocket 업그레이드에서 이미 쓰기 권한을 판정했고
   * (FR-703), 그 뒤로 그 연결은 닫히지 않는 한 같은 사람의 것이다. 여기서 또 보면
   * "누구의 권한으로" 저장하는지가 애매해진다 — 자동 저장의 주체는 **마지막으로 고친
   * 사람**이지 요청한 사람이 아니다.
   *
   * **충돌(409)을 보지 않는다.** 그것이 실시간 편집의 요지다 — Yjs가 이미 병합했고,
   * 여기 오는 문서는 그 병합의 결과다. 대신 `FOR UPDATE`로 REST 저장과 줄을 세운다.
   */
  async saveCollabVersion(
    id: string,
    title: string,
    content: DocNode,
    actorId: string,
    tx: Db,
    onMentions?: (m: MentionOutcome) => void,
  ): Promise<PageRow> {
    const [locked] = await tx.select().from(pages).where(and(eq(pages.id, id), isNull(pages.deletedAt))).for('update');
    if (!locked) throw new NotFoundException('페이지를 찾을 수 없다');
    // 직전 내용을 **버전을 더하기 전에** 읽는다. 알림은 그 둘의 차이로 만든다
    const previous = await tx.query.pageVersions.findFirst({
      where: and(eq(pageVersions.pageId, id), eq(pageVersions.versionNo, locked.currentVersionNo)),
    });
    const page = await this.appendVersion(tx, locked, title, content, actorId);
    // **협업 저장도 멘션을 만든다.** 이것이 없으면 실시간 편집이 기본인 지금
    // 페이지 본문의 `@멘션`이 앱 알림·메일 모두 0건이 된다 — Phase 3 FR-500 회귀였다
    // (자체 점검 4). REST 경로와 같은 함수를 쓴다
    const mentions = await this.notifications.notifyMentions(
      {
        doc: content,
        pageId: page.id,
        commentId: null,
        spaceId: page.spaceId,
        actorId,
        previousDoc: (previous?.contentJson as DocNode | undefined) ?? null,
      },
      tx,
    );
    onMentions?.(mentions);
    return page;
  }

  private async appendVersion(tx: Db, locked: PageRow, title: string, raw: DocNode, actorId: string): Promise<PageRow> {
    const nextNo = locked.currentVersionNo + 1;
    const content = stampSchemaVersion(raw);
    const text = extractText(content);
    await tx.insert(pageVersions).values({ pageId: locked.id, versionNo: nextNo, title, contentJson: content, contentText: text, createdBy: actorId });
    const [page] = await tx
      .update(pages)
      .set({ title, currentVersionNo: nextNo, searchText: text, updatedBy: actorId, updatedAt: sql`now()` })
      .where(eq(pages.id, locked.id))
      .returning();
    return page;
  }

  /**
   * 두 버전의 차이 (FR-720~726).
   *
   * 비교 자체는 `packages/shared`의 순수 함수가 한다. 여기서는 **권한과 조회**만 본다 —
   * 읽을 수 있어야 하고(FR-737과 같은 판정), 두 버전이 다 있어야 한다.
   */
  async diff(id: string, from: number, to: number, principal: Principal): Promise<PageDiffView> {
    const [a, b] = await Promise.all([this.version(id, from, principal), this.version(id, to, principal)]);
    return {
      from: { versionNo: a.versionNo, title: a.title, createdByName: a.createdByName, createdAt: a.createdAt },
      to: { versionNo: b.versionNo, title: b.title, createdByName: b.createdByName, createdAt: b.createdAt },
      titleChanged: a.title !== b.title,
      diff: diffDocs(a.content, b.content),
    };
  }

  /**
   * 내보낼 HTML (FR-730~737).
   *
   * **읽기 권한과 같은 판정이다** (FR-737) — `get`이 그것을 한다. 버전을 주면 그 버전을,
   * 안 주면 지금 것을 낸다.
   */
  async exportHtml(id: string, principal: Principal, versionNo?: number): Promise<{ filename: string; html: string; versionNo: number }> {
    const page = await this.get(id, principal);
    const target = versionNo === undefined ? null : await this.version(id, versionNo, principal);
    const space = await this.db.query.spaces.findFirst({ where: eq(spaces.id, page.spaceId) });
    const html = renderExportDocument({
      title: target?.title ?? page.title,
      doc: target?.content ?? page.content,
      exportedAt: new Date().toISOString(),
      spaceName: space?.name,
      versionNo: target?.versionNo ?? page.currentVersionNo,
    });
    // **파일 이름에 제목을 그대로 쓰지 않는다.** 경로 구분자나 제어문자가 들어가면
    // 내려받는 쪽에서 엉뚱한 곳에 저장된다. 안전한 글자만 남기고 비면 페이지 id를 쓴다
    const safe = (target?.title ?? page.title).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    return { filename: `${safe || page.id}.html`, html, versionNo: target?.versionNo ?? page.currentVersionNo };
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
    const [row] = await this.db
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
      .where(and(eq(pageVersions.pageId, id), eq(pageVersions.versionNo, versionNo)));
    if (!row) throw new NotFoundException('버전을 찾을 수 없다');
    return { ...row, content: row.content as DocNode, createdAt: row.createdAt.toISOString() };
  }

  /**
   * 복원 (FR-325). 되돌리는 것이 아니라 **그 내용으로 새 버전을 앞에 붙이는 것**이다.
   * 그래야 "언제 무엇으로 되돌렸는지"가 이력에 남는다.
   */
  async restoreVersion(id: string, versionNo: number, principal: Principal, tx: Db): Promise<PageView> {
    const current = await this.row(id, tx);
    await this.spaces.assertWrite(current.spaceId, principal, tx);
    const [locked] = await tx.select().from(pages).where(and(eq(pages.id, id), isNull(pages.deletedAt))).for('update');
    if (!locked) throw new NotFoundException('페이지를 찾을 수 없다');
    const old = await tx.query.pageVersions.findFirst({ where: and(eq(pageVersions.pageId, id), eq(pageVersions.versionNo, versionNo)) });
    if (!old) throw new NotFoundException('버전을 찾을 수 없다');
    const content = stampSchemaVersion(old.contentJson as DocNode);
    const page = await this.appendVersion(tx, locked, old.title, content, principal.id);
    return { ...toPageSummary(page), content, createdBy: page.createdBy, updatedBy: principal.id, createdAt: page.createdAt.toISOString() };
  }

  async move(id: string, dto: MovePageDto, principal: Principal, tx: Db): Promise<PageSummary> {
    const page = await this.row(id, tx);
    await this.spaces.assertWrite(page.spaceId, principal, tx);
    if (dto.parentId) await this.assertParent(tx, dto.parentId, page.spaceId, id);
    const [row] = await tx
      .update(pages)
      .set({ parentId: dto.parentId, position: dto.position, updatedBy: principal.id, updatedAt: sql`now()` })
      .where(eq(pages.id, id))
      .returning();
    return toPageSummary(row);
  }

  /** 삭제 (FR-329, FR-330). 하위가 있으면 막는다 — 고아 페이지를 만들지 않는다 */
  async softDelete(id: string, principal: Principal, tx: Db): Promise<PageRow> {
    const page = await this.row(id, tx);
    await this.spaces.assertWrite(page.spaceId, principal, tx);
    const children = await tx.select({ id: pages.id }).from(pages).where(and(eq(pages.parentId, id), isNull(pages.deletedAt)));
    if (children.length) throw new BadRequestException('하위 페이지가 있는 페이지는 삭제할 수 없다. 하위를 먼저 옮기거나 삭제한다');
    await tx.update(pages).set({ deletedAt: sql`now()`, updatedBy: principal.id, updatedAt: sql`now()` }).where(eq(pages.id, id));
    return page;
  }

  /**
   * 부모가 쓸 수 있는 것인지 본다 (FR-326~328).
   * **판정은 A등급 `checkMove`가 한다.** 여기서는 조상 사슬과 자손 높이를 모아 넘긴다.
   */
  private async assertParent(tx: Db, parentId: string, spaceId: string, selfId: string | null): Promise<void> {
    const ancestors: TreeNode[] = [];
    let cursor: string | null = parentId;
    // 순환된 데이터가 이미 있어도 멈추도록 한도를 둔다
    for (let i = 0; cursor && i <= PAGE_TREE_MAX_DEPTH + 1; i++) {
      const row: PageRow | undefined = await tx.query.pages.findFirst({ where: and(eq(pages.id, cursor), isNull(pages.deletedAt)) });
      if (!row) throw new NotFoundException('부모 페이지를 찾을 수 없다');
      ancestors.push({ id: row.id, parentId: row.parentId, spaceId: row.spaceId });
      cursor = row.parentId;
    }
    const subtreeHeight = selfId ? await this.subtreeHeight(tx, selfId) : 0;
    const r = checkMove({ selfId, spaceId, ancestors, maxDepth: PAGE_TREE_MAX_DEPTH, subtreeHeight });
    if (r.ok) return;
    if (r.reason === 'cycle') throw new BadRequestException('페이지를 자기 자신이나 자손 아래로 옮길 수 없다');
    if (r.reason === 'cross-space') throw new BadRequestException('다른 스페이스의 페이지를 부모로 둘 수 없다');
    throw new BadRequestException(`페이지 트리 깊이는 ${PAGE_TREE_MAX_DEPTH}를 넘을 수 없다`);
  }

  /** 이 페이지 아래로 가장 깊은 자손까지의 단수 (자손이 없으면 0) */
  private async subtreeHeight(tx: Db, id: string): Promise<number> {
    let level = [id];
    let h = 0;
    for (let i = 0; i < PAGE_TREE_MAX_DEPTH + 1 && level.length; i++) {
      const rows: { id: string }[] = await tx
        .select({ id: pages.id })
        .from(pages)
        .where(and(isNull(pages.deletedAt), sql`${pages.parentId} in ${level}`));
      if (!rows.length) break;
      h += 1;
      level = rows.map((r) => r.id);
    }
    return h;
  }

  /**
   * `search_text` 재생성 (FR-333). 파생 데이터는 언제든 다시 만들 수 있어야 한다.
   *
   * **정의는 `reindex.ts` 한 곳에 있다** — `pnpm search:reindex`와 같은 질의·같은 범위를
   * 쓴다. 예전에는 둘이 따로 적혀 있었고, 어긋나도 아무도 못 봤다.
   *
   * **아직 운영 호출자가 없다.** 관리 화면에서 부를 자리가 설계에 있지만(FR-333) 화면이
   * 없다. 실제 재색인 경로는 스크립트다 — 이 메서드의 커버리지는 "정의가 옳다"까지만
   * 보증한다 (3절·보류 10).
   */
  async reindexAll(): Promise<number> {
    const rows = await this.db.execute<ReindexRow>(sql.raw(REINDEX_SELECT_SQL));
    return reindexRows(rows.rows, (id, text) =>
      this.db.update(pages).set({ searchText: text }).where(eq(pages.id, id)),
    );
  }
}
