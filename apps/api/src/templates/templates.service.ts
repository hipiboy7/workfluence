import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { can, stampSchemaVersion, type DocNode, type PageTemplateView, type Principal } from '@workfluence/shared';
import { desc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { pageTemplates, type PageTemplateRow } from '../db/schema';

/**
 * 페이지 템플릿 (P6_설계서_Collab B.4절, FR-740~746).
 *
 * **전역이다** (FR-744). 스페이스별로 두지 않는 것은 그 요구가 확인되지 않았기 때문이다 —
 * 좁게 시작해 넓히는 것은 되지만 넓게 시작해 좁히는 것은 안 된다 (1.4절).
 *
 * **관리는 관리자만** (FR-743). 전원이 만들면 목록이 쓰레기로 찬다 — 라벨에서 이미 겪었다.
 */
const toView = (r: PageTemplateRow): PageTemplateView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  content: r.contentJson as DocNode,
  updatedAt: r.updatedAt.toISOString(),
});

@Injectable()
export class TemplatesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 목록은 **로그인한 사람 누구나** 본다. 새 페이지를 만들 때 골라야 하기 때문이다 */
  async list(tx: Db = this.db): Promise<PageTemplateView[]> {
    const rows = await tx.select().from(pageTemplates).orderBy(desc(pageTemplates.updatedAt));
    return rows.map(toView);
  }

  async get(id: string, tx: Db = this.db): Promise<PageTemplateView> {
    const row = await tx.query.pageTemplates.findFirst({ where: eq(pageTemplates.id, id) });
    if (!row) throw new NotFoundException('템플릿을 찾을 수 없다');
    return toView(row);
  }

  private assertAdmin(principal: Principal): void {
    if (!can(principal, 'space.manage')) throw new ForbiddenException('템플릿 관리는 관리자만 한다');
  }

  /**
   * 만든다. **같은 이름이면 그것을 돌려준다** (FR-745, 멱등).
   *
   * 409를 주지 않는 것은 분류(FR-308)와 같은 판단이다 — 화면에서는 "만들거나 고른다"가
   * 한 동작이고, 두 사람이 같은 이름을 동시에 넣었을 때 한쪽만 실패할 이유가 없다.
   * **덮어쓰지는 않는다.** 같은 이름으로 내용을 바꾸려면 고치기를 쓴다 — 멱등과 덮어쓰기는
   * 다른 말이고, 후자는 남의 템플릿을 말없이 바꾸는 길이 된다.
   */
  async create(
    dto: { name: string; description?: string | null; content: DocNode },
    principal: Principal,
    tx: Db = this.db,
  ): Promise<{ template: PageTemplateView; created: boolean }> {
    this.assertAdmin(principal);
    const existing = await tx.query.pageTemplates.findFirst({ where: eq(pageTemplates.name, dto.name) });
    if (existing) return { template: toView(existing), created: false };
    // **`onConflictDoNothing`으로 넣는다.** 위의 조회와 이 삽입 사이에 같은 이름이
    // 들어오면 UNIQUE 위반으로 500이 된다 — "멱등하다"고 적어 둔 바로 그 자리에서
    // 동시에 부르면 한쪽이 오류를 받는다 (P6 코드 리뷰 20)
    const [row] = await tx
      .insert(pageTemplates)
      .values({
        name: dto.name,
        description: dto.description ?? null,
        contentJson: stampSchemaVersion(dto.content),
        createdBy: principal.id,
        updatedBy: principal.id,
      })
      .onConflictDoNothing({ target: pageTemplates.name })
      .returning();
    if (!row) {
      // 그 사이에 남이 같은 이름으로 만들었다. 덮어쓰지 않고 그것을 돌려준다
      const raced = await tx.query.pageTemplates.findFirst({ where: eq(pageTemplates.name, dto.name) });
      if (!raced) throw new ConflictException('템플릿을 만들지 못했다');
      return { template: toView(raced), created: false };
    }
    return { template: toView(row), created: true };
  }

  async update(
    id: string,
    dto: { name?: string; description?: string | null; content?: DocNode },
    principal: Principal,
    tx: Db = this.db,
  ): Promise<PageTemplateView> {
    this.assertAdmin(principal);
    await this.get(id, tx);
    const [row] = await tx
      .update(pageTemplates)
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.content !== undefined ? { contentJson: stampSchemaVersion(dto.content) } : {}),
        updatedBy: principal.id,
        updatedAt: new Date(),
      })
      .where(eq(pageTemplates.id, id))
      .returning();
    return toView(row);
  }

  async remove(id: string, principal: Principal, tx: Db = this.db): Promise<void> {
    this.assertAdmin(principal);
    await this.get(id, tx);
    // **물리 삭제다.** 템플릿은 다른 것이 참조하지 않는다 — 페이지를 만들 때 내용을
    // 복사하고 끝이므로, 지워도 이미 만든 페이지는 그대로다 (휴지통을 둘 이유가 없다)
    await tx.delete(pageTemplates).where(eq(pageTemplates.id, id));
  }
}
