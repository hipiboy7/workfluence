import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ApiTokensService } from './api-tokens.service';

/** 공개 API 토큰 (docs/spinoff/public-api 계획서 4.1절) */
@Module({
  imports: [UsersModule],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
