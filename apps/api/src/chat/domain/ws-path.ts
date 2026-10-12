/**
 * 채팅 WebSocket의 경로 (P21_설계서_Chat C.1절). 업그레이드 처리기가 둘(편집·채팅)이라 **서로의 경로를 알아본다** — 편집 게이트웨이는 우리 경로가 아니면
 * 404로 닫으므로(P6 자체 점검 13) 채팅 경로를 먼저 가려 두지 않으면 채팅 연결이 닫힌다.
 *
 * `session` — 화면(세션 쿠키), `token` — headless(`Authorization: Bearer`). 질의 문자열은 떼고 본다. **토큰은 질의로 받지 않는다** — 주소에 남아 로그로 간다(7절)
 */
export type ChatWsKind = 'session' | 'token';

export function readChatWsPath(url: string | undefined): ChatWsKind | null {
  if (!url) return null;
  const path = url.split(/[?#]/)[0];
  if (path === '/api/chat/ws') return 'session';
  if (path === '/api/v1/chat/ws') return 'token';
  return null;
}
