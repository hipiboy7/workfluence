import { Body, Controller, Get, Global, Ip, Module, Post, UseGuards } from '@nestjs/common';
import { createUserDto, type CreateUserDto, type UserView } from '@workfluence/shared';
import { AuditService } from '../audit/audit.module';
import { AuthGuard, CurrentUser, RequireAction, type SessionUser } from '../auth/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { UsersService, toUserView } from './users.service';

@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireAction('user.manage')
  list(): Promise<UserView[]> {
    return this.users.list();
  }

  @Post()
  @RequireAction('user.manage')
  async create(
    @Body(new ZodPipe(createUserDto)) dto: CreateUserDto,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<UserView> {
    const row = await this.users.create(dto);
    await this.audit.record({
      action: 'user.create',
      actorId: actor.id,
      targetType: 'user',
      targetId: row.id,
      detail: { username: row.username, role: row.role },
      ip,
    });
    return toUserView(row);
  }
}

/** 전역 모듈: AuthGuard가 어느 모듈의 컨트롤러에 붙어도 UsersService를 해석할 수 있어야 한다 */
@Global()
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
