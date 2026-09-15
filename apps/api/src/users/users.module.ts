import { Body, Controller, Get, Global, HttpCode, Ip, Module, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { createUserDto, listLimitDto, updateUserRoleDto, type CreateUserDto, type UpdateUserRoleDto, type UserView } from '@workfluence/shared';
import { AuditService } from '../audit/audit.module';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { SpacesModule, SpacesService } from '../spaces/spaces.module';
import { UsersService, toUserView } from './users.service';

@Controller('api/users')
@UseGuards(AuthGuard)
@RequireAction('user.manage')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly spaces: SpacesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query(new ZodPipe(listLimitDto)) q: { limit: number }): Promise<UserView[]> {
    return this.users.list(q.limit);
  }

  @Post()
  async create(@Body(new ZodPipe(createUserDto)) dto: CreateUserDto, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<UserView> {
    const row = await this.users.create(dto, actor);
    await this.spaces.ensurePersonalSpace(row);
    await this.audit.record({ action: 'user.create', actorId: actor.id, targetType: 'user', targetId: row.id, detail: { username: row.username, role: row.role }, ip });
    return toUserView(row);
  }

  /** 승인 대기 → 활성. 승인과 함께 개인 스페이스를 만들어 준다 */
  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<UserView> {
    const row = await this.users.approve(id, actor);
    await this.spaces.ensurePersonalSpace(row);
    await this.audit.record({ action: 'user.approve', actorId: actor.id, targetType: 'user', targetId: row.id, detail: { username: row.username }, ip });
    return toUserView(row);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  async unlock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SessionUser, @Ip() ip: string): Promise<UserView> {
    const row = await this.users.unlock(id, actor);
    await this.audit.record({ action: 'user.unlock', actorId: actor.id, targetType: 'user', targetId: row.id, detail: { username: row.username }, ip });
    return toUserView(row);
  }

  /** 비밀번호 초기화: 임시 비밀번호를 1회 응답으로 돌려준다. 감사로그에는 값이 아니라 사건만 남긴다 */
  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<{ user: UserView; temporaryPassword: string }> {
    const { user, temporaryPassword } = await this.users.resetPassword(id, actor);
    await this.audit.record({ action: 'user.password.reset', actorId: actor.id, targetType: 'user', targetId: user.id, detail: { username: user.username }, ip });
    return { user: toUserView(user), temporaryPassword };
  }

  @Patch(':id/role')
  @RequireAction('user.role.change')
  async changeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateUserRoleDto)) dto: UpdateUserRoleDto,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<UserView> {
    const before = await this.users.findById(id);
    const row = await this.users.changeRole(id, dto.role, actor);
    await this.audit.record({
      action: 'user.role.change',
      actorId: actor.id,
      targetType: 'user',
      targetId: row.id,
      detail: { username: row.username, from: before?.role, to: row.role },
      ip,
    });
    return toUserView(row);
  }
}

/** 전역 모듈: AuthGuard가 어느 모듈의 컨트롤러에 붙어도 UsersService를 해석할 수 있어야 한다 */
@Global()
@Module({
  imports: [SpacesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
