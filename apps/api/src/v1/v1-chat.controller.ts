import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseFilters, UseGuards } from '@nestjs/common';
import {
  chatMessagesQueryDto,
  chatUserSearchDto,
  createChatRoomDto,
  inviteChatMembersDto,
  markChatReadDto,
  sendChatMessageDto,
  type ChatMessageView,
  type ChatRoomView,
  type ChatUserView,
} from '@workfluence/shared';
import { CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { ApiTokenGuard } from '../api-tokens/api-token.guard';
import { ChatApiRateGuard } from '../chat/chat-api-rate.guard';
import { ChatEnabledGuard } from '../chat/chat.enabled.guard';
import { V1ExceptionFilter } from './v1-error.filter';
import { ChatService } from '../chat/chat.service';

/**
 * 채팅 REST — 공개 API(v1, headless) (P21_설계서_Chat E절). 화면용(`chat/chat.controller.ts`)과 **본문·응답이 같고** 인증만 토큰이다 — 읽기는 `read`, 보내기·방 만들기·읽음은 `write` scope. 빈도 제한은 `ChatApiRateGuard`(채팅 쓰기는 공개 API의 분당 30이 아니라 `WF_CHAT_SEND_PER_MIN`).
 */
@Controller('api/v1/chat')
// 꺼져 있으면 예산을 쓰기 전에 404다(자체 점검 12) — 토큰 확인 → 켜짐 → 빈도 제한
@UseGuards(ApiTokenGuard, ChatEnabledGuard, ChatApiRateGuard)
@UseFilters(V1ExceptionFilter)
export class V1ChatController {
  constructor(private readonly svc: ChatService) {}

  @Get('rooms')
  async rooms(@CurrentUser() me: SessionUser): Promise<{ items: ChatRoomView[] }> {
    return { items: await this.svc.listRooms(me.id) };
  }

  @Post('rooms')
  async create(@Body(new ZodPipe(createChatRoomDto)) dto: ReturnType<typeof createChatRoomDto.parse>, @CurrentUser() me: SessionUser): Promise<ChatRoomView & { created: boolean }> {
    const r = await this.svc.createRoom(me, dto);
    return { ...r.room, created: r.created };
  }

  @Get('rooms/:id')
  room(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<ChatRoomView> {
    return this.svc.getRoom(me.id, id);
  }

  @Post('rooms/:id/members')
  invite(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(inviteChatMembersDto)) dto: ReturnType<typeof inviteChatMembersDto.parse>, @CurrentUser() me: SessionUser): Promise<ChatRoomView> {
    return this.svc.invite(me, id, dto.userIds);
  }

  @Delete('rooms/:id/members/me')
  async leave(@Param('id', UuidPipe) id: string, @CurrentUser() me: SessionUser): Promise<{ ok: true }> {
    await this.svc.leave(me, id);
    return { ok: true };
  }

  @Get('rooms/:id/messages')
  async messages(
    @Param('id', UuidPipe) id: string,
    @Query(new ZodPipe(chatMessagesQueryDto)) q: ReturnType<typeof chatMessagesQueryDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<{ items: ChatMessageView[] }> {
    return { items: await this.svc.listMessages(me, id, q) };
  }

  @Post('rooms/:id/messages')
  async send(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(sendChatMessageDto)) dto: ReturnType<typeof sendChatMessageDto.parse>,
    @CurrentUser() me: SessionUser,
  ): Promise<ChatMessageView & { duplicate: boolean }> {
    const r = await this.svc.send(me, id, dto);
    return { ...r.message, duplicate: r.duplicate };
  }

  @Put('rooms/:id/read')
  read(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(markChatReadDto)) dto: ReturnType<typeof markChatReadDto.parse>, @CurrentUser() me: SessionUser): Promise<{ lastReadSeq: number }> {
    return this.svc.markRead(me, id, dto.seq);
  }

  @Get('users')
  async users(@Query(new ZodPipe(chatUserSearchDto)) q: ReturnType<typeof chatUserSearchDto.parse>, @CurrentUser() me: SessionUser): Promise<{ items: ChatUserView[] }> {
    return { items: await this.svc.searchUsers(me, q.q, q.limit) };
  }
}
