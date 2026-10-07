import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  PayloadTooLargeException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  listLimitDto,
  matchLabel,
  toV1Attachment,
  toV1Comment,
  v1CommentDto,
  v1CommentUpdateDto,
  v1DownloadQuery,
  v1LabelDto,
  v1PageQuery,
  v1UploadDto,
  V1_DEFAULTS,
  type LabelView,
  type SearchHit,
  type V1AttachmentJson,
  type V1AttachmentView,
  type V1CommentView,
  type V1DownloadQuery,
  type V1PageQuery,
} from '@workfluence/shared';
import type { Request, Response } from 'express';
import { AttachmentsService, contentDisposition, type UploadedFileLike } from '../attachments/attachments.service';
import { AttachmentUseCases } from '../attachments/attachments.usecases';
import { canonicalMime } from '../attachments/domain/upload';
import { CurrentUser, type SessionUser } from '../auth/auth.guard';
import { CommentsService } from '../comments/comments.service';
import { CommentUseCases } from '../comments/comments.usecases';
import { metaOf } from '../common/request-meta';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { LabelsService } from '../labels/labels.service';
import { LabelUseCases } from '../labels/labels.usecases';
import { UseV1 } from './use-v1';

/**
 * 공개 API v1 — 댓글 (docs/spinoff/public-api 설계서 3.3·3.5절). 얇은 층이다(FR-2210) — 트랜잭션·감사·멘션 메일은 화면용과 같은 `CommentUseCases`가 한다.
 * 에이전트가 정하는 것은 **본문뿐**이다(답글이면 `parentId`). 본문은 마크다운이 기본이다.
 */
@Controller('api/v1')
@UseV1()
export class V1CommentsController {
  constructor(
    private readonly svc: CommentsService,
    private readonly uc: CommentUseCases,
  ) {}

  @Get('pages/:pageId/comments')
  async list(
    @Param('pageId', UuidPipe) pageId: string,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
  ): Promise<{ items: V1CommentView[] }> {
    return { items: (await this.svc.list(pageId, me)).map((c) => toV1Comment(c, query.format)) };
  }

  @Post('pages/:pageId/comments')
  async create(
    @Param('pageId', UuidPipe) pageId: string,
    @Body(new ZodPipe(v1CommentDto)) dto: ReturnType<typeof v1CommentDto.parse>,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1CommentView> {
    return toV1Comment(await this.uc.create(pageId, { parentId: dto.parentId, body: dto.doc }, me, metaOf(req)), query.format);
  }

  @Patch('comments/:id')
  async update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(v1CommentUpdateDto)) dto: ReturnType<typeof v1CommentUpdateDto.parse>,
    @Query(new ZodPipe(v1PageQuery)) query: V1PageQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1CommentView> {
    return toV1Comment(await this.uc.update(id, { body: dto.doc }, me, metaOf(req)), query.format);
  }

  @Delete('comments/:id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.remove(id, me, metaOf(req));
    return { ok: true };
  }
}

/** 공개 API v1 — 라벨. 이름만 다룬다(떼기도 이름으로) (설계서 3.5절) */
@Controller('api/v1')
@UseV1()
export class V1LabelsController {
  constructor(
    private readonly svc: LabelsService,
    private readonly uc: LabelUseCases,
  ) {}

  @Get('labels')
  all(@Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>): Promise<LabelView[]> {
    return this.svc.all(q.limit);
  }

  @Get('labels/:name/pages')
  async pages(
    @Param('name', new ZodPipe(v1LabelDto.shape.name)) name: string,
    @Query(new ZodPipe(listLimitDto)) q: ReturnType<typeof listLimitDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<{ items: SearchHit[] }> {
    return { items: await this.svc.findPages(name, me, q.limit) };
  }

  @Get('pages/:pageId/labels')
  forPage(@Param('pageId', UuidPipe) pageId: string, @CurrentUser() me: SessionUser): Promise<LabelView[]> {
    return this.svc.forPage(pageId, me);
  }

  @Post('pages/:pageId/labels')
  attach(
    @Param('pageId', UuidPipe) pageId: string,
    @Body(new ZodPipe(v1LabelDto)) dto: ReturnType<typeof v1LabelDto.parse>,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<LabelView> {
    return this.uc.attach(pageId, dto.name, me, metaOf(req));
  }

  /** 라벨을 **이름이나 id로** 뗀다 — 붙어 있지 않으면 404 */
  @Delete('pages/:pageId/labels/:ref')
  async detach(@Param('pageId', UuidPipe) pageId: string, @Param('ref') ref: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    const label = matchLabel(ref, await this.svc.forPage(pageId, me));
    if (!label) throw new NotFoundException({ code: 'LABEL_NOT_FOUND', message: '이 페이지에 붙어 있지 않은 라벨이다' });
    await this.uc.detach(pageId, label.id, me, metaOf(req));
    return { ok: true };
  }
}

/** 글로 읽히는 형식 — `format=json`이 utf8로 담는다. 그 밖은 base64 */
const isTextMime = (mime: string): boolean => mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';

/** 올리는 쪽이 말한 형식을 쓰지 않고 확장자에서 정한다. 허용 밖이면 서비스가 거절한다(여기서는 모르는 형식으로 넘긴다) */
function mimeOf(filename: string): string {
  try {
    return canonicalMime(filename);
  } catch {
    return 'application/octet-stream';
  }
}

/**
 * 공개 API v1 — 첨부 (docs/spinoff/public-api 설계서 3.5절 · FR-2218). 올리기는 **둘 중 아무 길**이다 — multipart(필드 `file`) 또는 JSON `{ filename, content, encoding }`
 * (에이전트는 바이너리를 보낼 수 없다). 받기는 바이너리, 또는 `?format=json`(글은 utf8·바이너리는 base64). 종류·크기·내용 검사와 감사는 화면용과 같은
 * `AttachmentUseCases`가 한다
 */
@Controller('api/v1')
@UseV1()
export class V1AttachmentsController {
  constructor(
    private readonly svc: AttachmentsService,
    private readonly uc: AttachmentUseCases,
  ) {}

  @Get('pages/:pageId/attachments')
  async list(@Param('pageId', UuidPipe) pageId: string, @CurrentUser() me: SessionUser): Promise<{ items: V1AttachmentView[] }> {
    return { items: (await this.svc.list(pageId, me)).map(toV1Attachment) };
  }

  @Post('pages/:pageId/attachments')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('pageId', UuidPipe) pageId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() body: unknown,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
  ): Promise<V1AttachmentView> {
    let upload = file;
    if (!upload) {
      const dto = new ZodPipe(v1UploadDto).transform(body ?? {});
      const buffer = Buffer.from(dto.content, dto.encoding === 'base64' ? 'base64' : 'utf8');
      if (buffer.length === 0) throw new BadRequestException('내용이 비어 있다');
      upload = { originalname: dto.filename, mimetype: mimeOf(dto.filename), size: buffer.length, buffer };
    }
    return toV1Attachment(await this.uc.upload(pageId, upload, me, metaOf(req)));
  }

  /** 받기 — 바이너리(머리: 형식·파일 이름·nosniff·no-store) 또는 `?format=json`. 감사는 유스케이스가 남긴다(FR-419) */
  @Get('attachments/:id')
  async download(
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(v1DownloadQuery)) query: V1DownloadQuery,
    @CurrentUser() me: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<V1AttachmentJson | undefined> {
    const { row, data } = await this.uc.download(id, me, metaOf(req));
    if (query.format === 'json') {
      if (data.length > V1_DEFAULTS.attachmentJsonMaxBytes) {
        throw new PayloadTooLargeException({ code: 'TOO_LARGE_FOR_JSON', message: `JSON으로 받기에 너무 크다(${V1_DEFAULTS.attachmentJsonMaxBytes}바이트까지) — format 없이 바이너리로 받는다` });
      }
      const text = data.toString('utf8');
      const asText = isTextMime(row.mime) && Buffer.from(text, 'utf8').equals(data);
      return { id: row.id, filename: row.filename, mime: row.mime, size: data.length, encoding: asText ? 'utf8' : 'base64', content: asText ? text : data.toString('base64') };
    }
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', contentDisposition(row.filename));
    // 브라우저가 내용을 보고 형식을 짐작해 **실행하지 않게** 한다 (FR-417)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
    return undefined;
  }

  @Delete('attachments/:id')
  async remove(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser, @Req() req: Request): Promise<{ ok: true }> {
    await this.uc.remove(id, me, metaOf(req));
    return { ok: true };
  }
}
