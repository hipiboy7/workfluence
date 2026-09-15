import { Body, Controller, Delete, Get, HttpCode, Ip, Module, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import {
  createPageDto,
  movePageDto,
  updatePageDto,
  type CreatePageDto,
  type DocNode,
  type MovePageDto,
  type PageSummary,
  type PageVersionView,
  type PageView,
  type UpdatePageDto,
} from '@workfluence/shared';
import { AuditModule } from '../audit/audit.module';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { AuthModule } from '../auth/auth.module';
import { ZodPipe } from '../common/zod.pipe';
import { PagesService } from './pages.service';

@Controller('api/pages')
@UseGuards(AuthGuard)
export class PagesController {
  constructor(private readonly svc: PagesService) {}

  @Post()
  @RequireAction('page.write')
  create(@Body(new ZodPipe(createPageDto)) dto: CreatePageDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<PageView> {
    return this.svc.create(dto, actor, ip);
  }

  @Get(':id')
  @RequireAction('page.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PageView> {
    return this.svc.get(id);
  }

  @Put(':id')
  @RequireAction('page.write')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updatePageDto)) dto: UpdatePageDto,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<PageView> {
    return this.svc.update(id, dto, actor, ip);
  }

  @Post(':id/move')
  @RequireAction('page.write')
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(movePageDto)) dto: MovePageDto,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<PageSummary> {
    return this.svc.move(id, dto, actor, ip);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAction('page.delete')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<void> {
    return this.svc.softDelete(id, actor, ip);
  }

  @Get(':id/versions')
  @RequireAction('page.read')
  versions(@Param('id', ParseUUIDPipe) id: string): Promise<PageVersionView[]> {
    return this.svc.versions(id);
  }

  @Get(':id/versions/:no')
  @RequireAction('page.read')
  version(@Param('id', ParseUUIDPipe) id: string, @Param('no', ParseIntPipe) no: number): Promise<PageVersionView & { content: DocNode }> {
    return this.svc.version(id, no);
  }

  @Post(':id/versions/:no/restore')
  @RequireAction('page.write')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<PageView> {
    return this.svc.restoreVersion(id, no, actor, ip);
  }
}

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [PagesController],
  providers: [PagesService],
  exports: [PagesService],
})
export class PagesModule {}
