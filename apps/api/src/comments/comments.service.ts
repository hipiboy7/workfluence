import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, stampSchemaVersion, type CommentView, type CreateCommentDto, type DocNode, type Principal, type UpdateCommentDto } from '@workfluence/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { comments, pages, users, type CommentRow, type PageRow } from '../db/schema';
import { SpacesService } from '../spaces/spaces.service';

/**
 * 댓글 (P3_설계서_Content 5절, FR-420~424).
 *
 * 본문은 페이지와 **같은 문서 검증**을 쓴다 (`createCommentDto`의 `documentSchema`).
 * 댓글만 따로 검증하면 페이지에서 막은 것이 댓글로 들어온다.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
  ) {}

  private async page(pageId: string, tx: Db): Promise<PageRow> {
    const row = await tx.query.pages.findFirst({ where: and(eq(pages.id, pageId), isNull(pages.deletedAt)) });
    if (!row) throw new NotFoundException('페이지를 찾을 수 없다');
    return row;
  }

  private async view(row: CommentRow, principal: Principal, canModerate: boolean, tx: Db): Promise<CommentView> {
    const who = await tx.query.users.findFirst({ where: eq(users.id, row.createdBy) });
    return {
      id: row.id,
      pageId: row.pageId,
      parentId: row.parentId,
      body: row.bodyJson as DocNode,
      createdBy: row.createdBy,
      createdByName: who?.displayName ?? '(삭제된 사용자)',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canDelete: row.createdBy === principal.id || canModerate,
    };
  }

  /** 지울 수 있는 사람: 작성자 본인 또는 그 스페이스에 쓸 수 있는 `page.delete` 권한자 (FR-422) */
  private moderates(access: { canWrite: boolean }, principal: Principal): boolean {
    return access.canWrite && can(principal, 'page.delete');
  }

  async list(pageId: string, principal: Principal, tx: Db = this.db): Promise<CommentView[]> {
    const page = await this.page(pageId, tx);
    const ctx = await this.spaces.context(page.spaceId, principal, tx); // 읽을 수 없으면 404
    const rows = await tx.query.comments.findMany({
      where: and(eq(comments.pageId, pageId), isNull(comments.deletedAt)),
      orderBy: asc(comments.createdAt),
    });
    const canModerate = this.moderates(ctx.access, principal);
    return Promise.all(rows.map((r) => this.view(r, principal, canModerate, tx)));
  }

  async create(pageId: string, dto: CreateCommentDto, principal: Principal, tx: Db = this.db): Promise<CommentView> {
    const page = await this.page(pageId, tx);
    const ctx = await this.spaces.assertWrite(page.spaceId, principal, tx);

    if (dto.parentId) {
      const parent = await tx.query.comments.findFirst({ where: and(eq(comments.id, dto.parentId), isNull(comments.deletedAt)) });
      if (!parent || parent.pageId !== pageId) throw new BadRequestException('원 댓글을 찾을 수 없다');
      // 한 단계까지다 (FR-421). 대댓글의 대댓글을 허용하면 화면의 들여쓰기가 끝없이 깊어진다
      if (parent.parentId) throw new BadRequestException('대댓글에는 다시 답할 수 없다');
    }

    const [row] = await tx
      .insert(comments)
      // 페이지와 같은 이유로 **서버가 버전을 찍는다** (P2 자체 점검 #2). 클라이언트가 빠뜨려도 정본에는 남는다
      .values({ pageId, parentId: dto.parentId ?? null, bodyJson: stampSchemaVersion(dto.body), createdBy: principal.id })
      .returning();
    return this.view(row, principal, this.moderates(ctx.access, principal), tx);
  }

  /** 고치는 것은 작성자 본인만이다. 남의 말을 고치는 것은 지우는 것과 다른 문제다 */
  async update(id: string, dto: UpdateCommentDto, principal: Principal, tx: Db = this.db): Promise<CommentView> {
    const row = await tx.query.comments.findFirst({ where: and(eq(comments.id, id), isNull(comments.deletedAt)) });
    if (!row) throw new NotFoundException('댓글을 찾을 수 없다');
    const page = await this.page(row.pageId, tx);
    const ctx = await this.spaces.assertWrite(page.spaceId, principal, tx);
    if (row.createdBy !== principal.id) throw new ForbiddenException('남의 댓글은 고칠 수 없다');

    const [next] = await tx
      .update(comments)
      .set({ bodyJson: stampSchemaVersion(dto.body), updatedAt: new Date() })
      .where(eq(comments.id, id))
      .returning();
    return this.view(next, principal, this.moderates(ctx.access, principal), tx);
  }

  async remove(id: string, principal: Principal, tx: Db = this.db): Promise<CommentRow> {
    const row = await tx.query.comments.findFirst({ where: and(eq(comments.id, id), isNull(comments.deletedAt)) });
    if (!row) throw new NotFoundException('댓글을 찾을 수 없다');
    const page = await this.page(row.pageId, tx);
    const ctx = await this.spaces.context(page.spaceId, principal, tx);
    if (row.createdBy !== principal.id && !this.moderates(ctx.access, principal)) {
      throw new ForbiddenException('이 댓글을 지울 권한이 없다');
    }
    // soft delete (CLAUDE.md 6절). 대댓글은 함께 지우지 않는다 — 답만 남으면 문맥이 사라지지만,
    // 남의 답을 지우는 쪽이 더 큰 일이다. 화면은 지워진 원 댓글 자리를 비워 둔다
    await tx.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, id));
    return row;
  }
}
