import { Injectable } from '@nestjs/common';
import type { ChatMessageView } from '@workfluence/shared';

/**
 * 채팅 사건을 연결 게이트웨이에 알리는 가운데 지점 (P21_설계서_Chat C.2절). 서비스는 게이트웨이를 모른다 — 연결은 끌 수 있는 것(`WF_CHAT_ENABLED`)이고,
 * 끌 수 있는 것에 서비스가 의존하면 그것은 끌 수 있는 것이 아니다(`RevocationBus`와 같은 판단). 한 프로세스 안의 메모리다(이중화를 하지 않는다 — 0.1절).
 *
 * **듣는 쪽이 던져도 삼킨다** — 메시지는 이미 커밋됐다. 알림이 실패해서 보내기가 실패로 보이면 보낸 사람이 같은 메시지를 다시 보낸다.
 */
@Injectable()
export class ChatHub {
  private readonly messageListeners = new Set<(memberIds: string[], message: ChatMessageView) => void>();
  private readonly roomListeners = new Set<(userId: string, roomId: string, change: 'joined' | 'left') => void>();

  onMessage(fn: (memberIds: string[], message: ChatMessageView) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onRoom(fn: (userId: string, roomId: string, change: 'joined' | 'left') => void): () => void {
    this.roomListeners.add(fn);
    return () => this.roomListeners.delete(fn);
  }

  publishMessage(memberIds: string[], message: ChatMessageView): void {
    for (const fn of this.messageListeners) {
      try {
        fn(memberIds, message);
      } catch {
        /* 삼킨다 */
      }
    }
  }

  publishRoom(userId: string, roomId: string, change: 'joined' | 'left'): void {
    for (const fn of this.roomListeners) {
      try {
        fn(userId, roomId, change);
      } catch {
        /* 삼킨다 */
      }
    }
  }
}
