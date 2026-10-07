import { Inject, Injectable } from '@nestjs/common';
import type { CreatePageDto, FlushCollabDto, MovePageDto, PageSummary, PageView, UpdatePageDto } from '@workfluence/shared';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/auth.guard';
import type { RequestMeta } from '../common/request-meta';
import { DB, type Db } from '../db/db.module';
import { MentionMailService } from '../mail/mention-mail.service';
import type { MentionOutcome } from '../notifications/notifications.service';
import { SpacesService } from '../spaces/spaces.service';
import { CollabGateway } from './collab/collab.gateway';
import { PagesService } from './pages.service';

/**
 * 페이지 (P2_설계서_Page 3절). 모든 쓰기는 감사로그와 **같은 트랜잭션**이고, 멘션 메일은 **커밋된 뒤에** 보낸다(FR-754). 판정·잠금·트리는 서비스가
 * 본다. 화면용 경로와 공개 API가 함께 부른다 (docs/spinoff/public-api 계획서 7.1절). 읽기는 서비스를 바로 부른다
 */
@Injectable()
export class PageUseCases {
  constructor(
    private readonly pages: PagesService,
    private readonly audit: AuditService,
    private readonly collab: CollabGateway,
    private readonly mentionMail: MentionMailService,
    private readonly spaces: SpacesService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async create(dto: CreatePageDto, me: SessionUser, meta: RequestMeta): Promise<PageView> {
    const collected: MentionOutcome[] = [];
    const page = await this.db.transaction(async (tx) => {
      const p = await this.pages.create(dto, me, tx, (m) => collected.push(m));
      await this.audit.record(
        { action: 'page.create', actorId: me.id, targetType: 'page', targetId: p.id, detail: { spaceId: dto.spaceId, title: dto.title }, ip: meta.ip },
        tx,
      );
      return p;
    });
    // 커밋된 뒤에 보낸다 (FR-754). 저장과 같은 길이다 — 새 페이지만 빠져 있었다 (P8 자체 점검 6)
    this.sendMentionMail(collected[0], page.title, me);
    return page;
  }

  async update(id: string, dto: UpdatePageDto, me: SessionUser, meta: RequestMeta): Promise<PageView> {
    const collected: MentionOutcome[] = [];
    const page = await this.db.transaction(async (tx) => {
      const p = await this.pages.update(id, dto, me, tx, (m) => collected.push(m));
      await this.audit.record(
        { action: 'page.update', actorId: me.id, targetType: 'page', targetId: id, detail: { versionNo: p.currentVersionNo }, ip: meta.ip },
        tx,
      );
      return p;
    });
    this.sendMentionMail(collected[0], page.title, me);
    return page;
  }

  /**
   * **기다리지 않는다** — 메일이 느려도 저장 응답은 나가야 한다. 실패해도 던지지 않는 것은 `MentionMailService`가 보장한다(FR-753). 일으킨 사람을
   * 넘긴다 — 빠뜨리면 `mail.send` 감사의 actor가 빈다 (P8 FR-906)
   */
  private sendMentionMail(mentions: MentionOutcome | undefined, title: string, me: SessionUser): void {
    if (mentions?.count) void this.mentionMail.notify(mentions, me.displayName, title, me.id);
  }

  async move(id: string, dto: MovePageDto, me: SessionUser, meta: RequestMeta): Promise<{ page: PageSummary }> {
    return this.db.transaction(async (tx) => {
      const { page, from, to } = await this.pages.move(id, dto, me, tx);
      // **어디서 어디로 옮겼나를 남긴다** (P14 병합 전 검토) — 요청한 값만 적으면 형제 수로 잘린 실제 자리와 옛 부모가 남지 않았다
      await this.audit.record({ action: 'page.move', actorId: me.id, targetType: 'page', targetId: id, detail: { from, to }, ip: meta.ip }, tx);
      return { page };
    });
  }

  async remove(id: string, me: SessionUser, meta: RequestMeta): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const page = await this.pages.softDelete(id, me, tx);
      await this.audit.record({ action: 'page.delete', actorId: me.id, targetType: 'page', targetId: id, detail: { title: page.title }, ip: meta.ip }, tx);
    });
    return { ok: true };
  }

  async restoreVersion(id: string, no: number, me: SessionUser, meta: RequestMeta): Promise<PageView> {
    return this.db.transaction(async (tx) => {
      const page = await this.pages.restoreVersion(id, no, me, tx);
      await this.audit.record(
        { action: 'page.version.restore', actorId: me.id, targetType: 'page', targetId: id, detail: { from: no, to: page.currentVersionNo }, ip: meta.ip },
        tx,
      );
      return page;
    });
  }

  /**
   * **실시간 편집의 제목** (P13 D.7, FR-1460). 쓰기 권한을 본다. 사람이 없는 방이면 곧바로 남기고, 방이 없으면 열어서 남긴다
   * (`CollabGateway.setTitle`). 실시간 편집이 꺼져 있으면 `applied: false`
   */
  async collabTitle(id: string, title: string, me: SessionUser): Promise<{ applied: boolean }> {
    const page = await this.pages.get(id, me);
    await this.spaces.assertWrite(page.spaceId, me);
    const applied = await this.collab.setTitle(id, title, me.id);
    // **바꾼 사람을 남긴다** (병합 전 보안 검토 L2). 저장의 작성자는 마지막으로 친 사람이라, 뒤에 다른 사람이 치면 제목을 바꾼 사람이
    // 이력과 감사로그에서 사라진다 — flush의 `page.collab.flush`(P7 보안 검토 F3)와 같은 까닭이다
    if (applied) await this.audit.record({ action: 'page.collab.title', actorId: me.id, targetType: 'page', targetId: id, detail: { title } });
    return { applied };
  }

  /**
   * 실시간 편집 중인 문서를 **지금 바로** 버전으로 남긴다 (FR-706의 사람 쪽 문). 방이 없으면 `saved: false`다 — 오류가 아니다. 자동 저장이 이미
   * 남겼으면 `saved: true, unchanged: true`(P13 FR-1462). 화면이 보낸 스냅숏(넣은 것과 지운 것)만큼 받지 못했으면 `saved: false`(P13 D.7)
   */
  async flush(id: string, dto: FlushCollabDto, me: SessionUser): Promise<{ saved: boolean; reason: string; unchanged: boolean; currentVersionNo: number }> {
    // **쓰기 권한을 본다.** WebSocket을 거치지 않고 부를 수 있는 경로이고, 읽기만 되는 사람이 강제 저장을 일으키면 유휴 묶음(FR-707)이
    // 무력해진다 (자체 점검 16)
    const page = await this.pages.get(id, me);
    await this.spaces.assertWrite(page.spaceId, me);
    const result = await this.collab.flush(id, dto.title, dto.snapshot ? new Uint8Array(Buffer.from(dto.snapshot, 'base64')) : undefined);
    // **누가 눌렀는지 남긴다** (P7 보안 검토 F3). 저장되는 버전의 작성자는 실제로 글자를 바꾼 사람(FR-802)이라, 이것이 없으면 "B가 A의 문서를
    // B가 정한 제목으로 남겼는데 이력과 감사로그에는 A만 보이는" 상태가 된다
    await this.audit.record({
      action: 'page.collab.flush',
      actorId: me.id,
      targetType: 'page',
      targetId: id,
      // **새로 남겼나, 이미 있었나를 가른다** (병합 전 코드 리뷰 7) — 고칠 수 없는 기록에서 둘이 같은 `saved: true`로 보였다
      detail: { saved: result.saved, unchanged: result.unchanged ?? false, reason: result.reason, titleGiven: dto.title ?? null },
    });
    const after = await this.pages.get(id, me);
    return { saved: result.saved, reason: result.reason, unchanged: result.unchanged ?? false, currentVersionNo: after.currentVersionNo };
  }

  /**
   * HTML 한 파일 (FR-730~737). **감사로그에 남긴다** (FR-736) — 문서가 앱 밖으로 나가는 경로라 "누가 언제 무엇을"이 남아야 한다. 첨부 다운로드를
   * 남기는 것과 같은 판단이다 (6절). 응답 머리는 컨트롤러가 붙인다
   */
  async exportHtml(id: string, versionNo: number | undefined, me: SessionUser, meta: RequestMeta): Promise<{ filename: string; html: string; versionNo: number }> {
    const out = await this.pages.exportHtml(id, me, versionNo);
    await this.audit.record({ action: 'page.export', actorId: me.id, targetType: 'page', targetId: id, detail: { versionNo: out.versionNo }, ip: meta.ip });
    return out;
  }
}
