import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
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
import { AuthGuard, CurrentUser, type SessionUser } from '../auth/auth.guard';
import { UuidPipe } from '../common/uuid.pipe';
import { ZodPipe } from '../common/zod.pipe';
import { ChatEnabledGuard } from './chat.enabled.guard';
import { ChatService } from './chat.service';

/**
 * 채팅 REST — 화면용 (P21_설계서_Chat E절). 세션 + CSRF 머리말. **자기가 참여한 방만 본다** — 방 id가 맞아도 참여자가 아니면 없는 방과 같은 404다.
 * headless용(`v1/v1-chat.controller.ts`)이 같은 서비스를 부른다
 */
@Controller('api/chat')
@UseGuards(AuthGuard, ChatEnabledGuard)
export class ChatController {
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
