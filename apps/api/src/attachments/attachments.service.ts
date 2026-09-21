import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { type AttachmentView, type Principal } from '@workfluence/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { attachments, pages, users, type AttachmentRow, type PageRow } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { SpacesService } from '../spaces/spaces.service';
import { checkSignature } from './domain/signature';
import { canonicalMime, checkUpload, extensionOf, mbToBytes } from './domain/upload';
import { SCANNER, STORAGE, type AttachmentScanner, type StorageProvider } from './storage/storage.provider';

/** multer가 넘기는 것 중 우리가 쓰는 것만. `@types/multer`를 의존성으로 들이지 않으려고 여기서 좁게 적는다 */
export type UploadedFileLike = { originalname: string; mimetype: string; size: number; buffer: Buffer };

/**
 * 첨부 (P3_설계서_Content 3절, FR-410~419).
 *
 * 판정은 A등급 `domain/upload.ts`가, 저장은 `StorageProvider`가 한다. 여기 있는 것은
 * **두 가지를 잇는 절차와 권한**뿐이다 (CLAUDE.md 2절 SRP).
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StorageProvider,
    @Inject(SCANNER) private readonly scanner: AttachmentScanner,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly spaces: SpacesService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 첨부가 매달린 페이지. **지워진 페이지는 없는 것으로 본다** (FR-427) —
   * 페이지를 지우면 첨부·댓글도 함께 보이지 않아야 한다.
   */
  private async page(pageId: string, tx: Db): Promise<PageRow> {
    const row = await tx.query.pages.findFirst({ where: and(eq(pages.id, pageId), isNull(pages.deletedAt)) });
    if (!row) throw new NotFoundException('페이지를 찾을 수 없다');
    return row;
  }

  private async view(row: AttachmentRow, tx: Db): Promise<AttachmentView> {
    const who = await tx.query.users.findFirst({ where: eq(users.id, row.uploadedBy) });
    return {
      id: row.id,
      pageId: row.pageId,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      uploadedBy: row.uploadedBy,
      uploadedByName: who?.displayName ?? '(삭제된 사용자)',
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(pageId: string, principal: Principal, tx: Db = this.db): Promise<AttachmentView[]> {
    const page = await this.page(pageId, tx);
    await this.spaces.context(page.spaceId, principal, tx); // 읽을 수 없으면 404
    const rows = await tx.query.attachments.findMany({
      where: and(eq(attachments.pageId, pageId), isNull(attachments.deletedAt)),
      orderBy: desc(attachments.createdAt),
    });
    return Promise.all(rows.map((r) => this.view(r, tx)));
  }

  async upload(pageId: string, file: UploadedFileLike, principal: Principal, tx: Db = this.db): Promise<AttachmentView> {
    const page = await this.page(pageId, tx);
    await this.spaces.assertWrite(page.spaceId, principal, tx);

    // **정책값을 읽는다** — 관리자가 화면에서 바꾸면 재기동 없이 다음 요청부터 먹는다 (FR-523).
    // 환경변수는 이 기계의 천장이고, 그 아래에서 운영이 조절한다
    const policy = await this.settings.get(tx);
    const verdict = checkUpload({
      filename: file.originalname,
      mime: file.mimetype,
      size: file.size,
      maxBytes: mbToBytes(policy.uploadMaxMb),
      allowedExtensions: policy.allowedExtensions,
    });
    if (!verdict.ok) {
      // 크기는 413이다 (FR-415). 400으로 주면 "고쳐서 다시 보내라"로 읽혀 같은 파일을 또 보낸다
      if (verdict.reason === 'size') throw new PayloadTooLargeException(verdict.message);
      throw new BadRequestException(verdict.message);
    }

    // **이름과 선언한 형식은 둘 다 올리는 쪽이 정한다.** 그래서 내용을 한 번 더 본다 (FR-414b).
    // `.hwp`가 `application/octet-stream`을 받아야 하는 현실 때문에 앞의 두 검사만으로는
    // "이름이 .hwp면 바이트는 무엇이든"이 되어 버린다
    const signature = checkSignature(extensionOf(file.originalname), file.buffer);
    if (!signature.ok) throw new BadRequestException(signature.message);

    const scanned = await this.scanner.scan(file.buffer, file.originalname);
    if (!scanned.ok) throw new BadRequestException(`첨부 검사에서 거부됐다: ${scanned.reason}`);

    // 내용 해시가 파일 이름이다 (FR-411). 같은 내용을 다시 올리면 **파일은 한 벌이고 메타데이터만 는다** (FR-413)
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    if (!(await this.storage.has(sha256))) await this.storage.put(sha256, file.buffer);

    const [row] = await tx
      .insert(attachments)
      // **선언한 형식이 아니라 우리가 도출한 형식을 저장한다** — 이 값이 다운로드 응답 헤더가 된다
      .values({ pageId, sha256, filename: file.originalname, mime: canonicalMime(file.originalname), size: file.size, uploadedBy: principal.id })
      .returning();
    return this.view(row, tx);
  }

  /** 다운로드. 권한은 그 페이지의 스페이스 판정을 따른다 (FR-416) */
  async download(id: string, principal: Principal, tx: Db = this.db): Promise<{ row: AttachmentRow; data: Buffer }> {
    const row = await tx.query.attachments.findFirst({ where: and(eq(attachments.id, id), isNull(attachments.deletedAt)) });
    if (!row) throw new NotFoundException('첨부를 찾을 수 없다');
    const page = await this.page(row.pageId, tx);
    await this.spaces.context(page.spaceId, principal, tx);
    return { row, data: await this.storage.get(row.sha256) };
  }

  /**
   * 삭제는 메타데이터만 지운다(soft delete).
   *
   * **실제 파일은 지우지 않는다** — 같은 내용을 여러 페이지가 참조할 수 있어서(FR-413),
   * 여기서 지우면 남의 첨부가 깨진다. 물리 삭제는 보존 기간 뒤 배치의 일이다 (CLAUDE.md 6절).
   */
  async remove(id: string, principal: Principal, tx: Db = this.db): Promise<AttachmentRow> {
    const row = await tx.query.attachments.findFirst({ where: and(eq(attachments.id, id), isNull(attachments.deletedAt)) });
    if (!row) throw new NotFoundException('첨부를 찾을 수 없다');
    const page = await this.page(row.pageId, tx);
    // **중지된 스페이스에서는 올린 사람도 지우지 못한다.** `spaceAccess`가 "중지 상태: 누구도
    // 쓰기 불가"로 판정하는데 여기서 작성자만 빠져나가면 판정이 두 벌이 된다 (P3 자체 점검 #4)
    const ctx = await this.spaces.assertWrite(page.spaceId, principal, tx);
    if (!ctx.access.canWrite && row.uploadedBy !== principal.id) throw new ForbiddenException('이 첨부를 지울 권한이 없다');
    await tx.update(attachments).set({ deletedAt: new Date() }).where(eq(attachments.id, id));
    return row;
  }
}

/**
 * 헤더에 넣을 파일명을 다듬는다.
 *
 * 따옴표·줄바꿈이 그대로 들어가면 **헤더가 깨지거나 새 헤더가 끼어든다.** 원본 이름은
 * 사용자 입력이므로 ASCII 대체본은 좁게 거르고, 한글 등은 RFC 5987 `filename*`로 보낸다.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
