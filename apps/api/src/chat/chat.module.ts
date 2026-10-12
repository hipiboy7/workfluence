import { Module } from '@nestjs/common';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { UsersModule } from '../users/users.module';
import { ChatController } from './chat.controller';
import { ChatEnabledGuard } from './chat.enabled.guard';
import { ChatGateway } from './chat.gateway';
import { ChatHub } from './chat.hub';
import { ChatService } from './chat.service';
import { ChatApiRateGuard } from './chat-api-rate.guard';

/**
 * 채팅 (P21_설계서_Chat). 화면용 REST(`ChatController`)와 연결(`ChatGateway`)이 여기 있고, headless용 REST(`V1ChatController`)는 공개 API 모듈(`V1Module`)이
 * 이 모듈의 서비스를 불러 쓴다 — 규칙은 `ChatService` 한 곳이다
 */
@Module({
  imports: [UsersModule, ApiTokensModule],
  providers: [ChatService, ChatHub, ChatGateway, ChatEnabledGuard, ChatApiRateGuard],
  controllers: [ChatController],
  exports: [ChatService, ChatGateway, ChatEnabledGuard, ChatApiRateGuard],
})
export class ChatModule {}
