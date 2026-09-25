import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 요청 하나의 문맥 (P11_설계서_Ops D.2) — 식별자와, 가드가 확인한 뒤의 사용자. 로그 줄(`logger.ts`의 mixin)과 감사 행
 * (`audit.service.ts`)이 여기서 읽는다.
 *
 * **첫 미들웨어에서 `run()`한다**(`main.ts`). 그 뒤의 body parser·express-session(PostgreSQL 저장소의 콜백)·가드·서비스·await한 DB
 * 질의 뒤·오류 처리기까지 문맥이 이어지는 것을 실측했다(설계서 D.2) — 콜백을 쓰는 저장소가 문맥을 잃는다고 알려져 있어 가정하지 않았다.
 * 요청 밖(한 시간마다의 정리·실시간 편집의 WebSocket 메시지)에서는 문맥이 없다 — 읽는 쪽이 비운다.
 */
export type RequestContext = { readonly requestId: string; userId?: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function runInRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/** 가드가 사용자를 확인했다 — 그 뒤의 로그 줄에 `userId`가 실린다 */
export function setRequestUser(userId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.userId = userId;
}
