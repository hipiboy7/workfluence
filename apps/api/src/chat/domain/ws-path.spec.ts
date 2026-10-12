import { describe, expect, it } from 'vitest';
import { readChatWsPath } from './ws-path';

describe('readChatWsPath (P21 C.1)', () => {
  it('화면용과 headless용 경로를 가른다', () => {
    expect(readChatWsPath('/api/chat/ws')).toBe('session');
    expect(readChatWsPath('/api/v1/chat/ws')).toBe('token');
  });
  it('질의·해시는 떼고 본다 — 토큰이 질의로 와도 이 경로로는 읽지 않는다(인증은 헤더만)', () => {
    expect(readChatWsPath('/api/chat/ws?x=1')).toBe('session');
    expect(readChatWsPath('/api/v1/chat/ws#a')).toBe('token');
  });
  it('다른 경로는 null — 편집 게이트웨이가 처리한다', () => {
    expect(readChatWsPath('/api/ws/pages/11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(readChatWsPath('/api/chat/ws/x')).toBeNull();
    expect(readChatWsPath('/api/chat/wsx')).toBeNull();
    expect(readChatWsPath(undefined)).toBeNull();
  });
});
