import { BadRequestException, Controller, Delete, Get, Module, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, MulterModule } from '@nestjs/platform-express';
import type { AttachmentView } from '@workfluence/shared';
import type { Request, Response } from 'express';
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { AttachmentsService, contentDisposition, type UploadedFileLike } from './attachments.service';
import { AttachmentUseCases } from './attachments.usecases';
import { mbToBytes } from './domain/upload';
import { LocalDiskStorage } from './storage/local.storage';
import { PassThroughScanner, SCANNER, STORAGE } from './storage/storage.provider';

@Controller('api')
@UseGuards(AuthGuard)
export class AttachmentsController {
  constructor(
    private readonly svc: AttachmentsService,
    private readonly uc: AttachmentUseCases,
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
    return this.uc.upload(pageId, file, me, metaOf(req));
  }

  /** 다운로드 — 감사는 유스케이스가 남긴다 (FR-419) */
  @Get('attachments/:id')
  async download(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { row, data } = await this.uc.download(id, me, metaOf(req));
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
    await this.uc.remove(id, me, metaOf(req));
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
        limits: { fileSize: mbToBytes(env.WF_UPLOAD_MAX_MB), files: 1 },
        // **한글 파일명이 깨진다.** multer 기본값은 latin1이라 `보고서.txt`가 `ë³´ê³ ì<...>`로 들어온다.
        // 조용히 잘못되는 유형이다 — 업로드는 성공하고 목록에도 나오는데 이름만 읽을 수 없다 (T-018)
        defParamCharset: 'utf8',
      }),
    }),
  ],
  providers: [
    AttachmentsService,
    AttachmentUseCases,
    { provide: STORAGE, useClass: LocalDiskStorage },
    { provide: SCANNER, useClass: PassThroughScanner },
  ],
  controllers: [AttachmentsController],
  exports: [AttachmentsService, AttachmentUseCases],
})
export class AttachmentsModule {}
