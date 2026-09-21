import { BadRequestException, Controller, Delete, Get, Inject, Module, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, MulterModule } from '@nestjs/platform-express';
import type { AttachmentView } from '@workfluence/shared';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { AttachmentsService, contentDisposition, type UploadedFileLike } from './attachments.service';
import { LocalDiskStorage } from './storage/local.storage';
import { PassThroughScanner, SCANNER, STORAGE } from './storage/storage.provider';

@Controller('api')
@UseGuards(AuthGuard)
export class AttachmentsController {
  constructor(
    private readonly svc: AttachmentsService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('pages/:pageId/attachments')
  list(@Param('pageId', UuidPipe) pageId: string, @CurrentUser() me: SessionUser): Promise<AttachmentView[]> {
    return this.svc.list(pageId, me);
  }

  @Post('pages/:pageId/attachments')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Param('pageId', UuidPipe) pageId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<AttachmentView> {
    if (!file) throw new BadRequestException('파일이 없다 (필드 이름은 file)');
    return this.db.transaction(async (tx) => {
      const view = await this.svc.upload(pageId, file, me, tx);
      await this.audit.record(
        { action: 'attachment.upload', actorId: me.id, targetType: 'attachment', targetId: view.id, detail: { pageId, filename: view.filename, size: view.size }, ip: req.ip },
        tx,
      );
      return view;
    });
  }

  /** 다운로드를 감사로그에 남긴다 (FR-419). 읽기지만 **무엇을 가져갔는지**는 남아야 한다 */
  @Get('attachments/:id')
  async download(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { row, data } = await this.db.transaction(async (tx) => {
      const got = await this.svc.download(id, me, tx);
      await this.audit.record(
        { action: 'attachment.download', actorId: me.id, targetType: 'attachment', targetId: id, detail: { pageId: got.row.pageId, filename: got.row.filename }, ip: req.ip },
        tx,
      );
      return got;
    });
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', contentDisposition(row.filename));
    // 브라우저가 내용을 보고 형식을 짐작해 **실행하지 않게** 한다 (FR-417)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  }

  @Delete('attachments/:id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      const row = await this.svc.remove(id, me, tx);
      await this.audit.record(
        { action: 'attachment.delete', actorId: me.id, targetType: 'attachment', targetId: id, detail: { pageId: row.pageId, filename: row.filename }, ip: req.ip },
        tx,
      );
    });
    return { ok: true };
  }
}

@Module({
  imports: [
    // 크기 상한을 **multer에도** 준다. 여기서 막지 않으면 상한을 넘는 파일이 일단 메모리에
    // 다 올라온 뒤에야 413이 난다. 판정(FR-415)은 도메인이 하고, 이것은 그 앞의 방벽이다
    MulterModule.registerAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnvToken) => ({
        limits: { fileSize: env.WF_UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
        // **한글 파일명이 깨진다.** multer 기본값은 latin1이라 `보고서.txt`가 `ë³´ê³ ì<...>`로 들어온다.
        // 조용히 잘못되는 유형이다 — 업로드는 성공하고 목록에도 나오는데 이름만 읽을 수 없다 (T-018)
        defParamCharset: 'utf8',
      }),
    }),
  ],
  providers: [
    AttachmentsService,
    { provide: STORAGE, useClass: LocalDiskStorage },
    { provide: SCANNER, useClass: PassThroughScanner },
  ],
  controllers: [AttachmentsController],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
