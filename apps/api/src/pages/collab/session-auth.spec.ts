import { sign } from 'cookie-signature';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, readClientIp, readPageId, readSessionId } from './session-auth';

const SECRET = 'test-secret-that-is-long-enough-000000';
const signed = (sid: string, secret = SECRET) => `${SESSION_COOKIE}=s%3A${encodeURIComponent(sign(sid, secret)).replace(/^s%3A/, '')}`;

describe('readSessionId (FR-703)', () => {
  const sid = 'abc123';
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(`s:${sign(sid, SECRET)}`)}`;

  it('서명이 맞으면 세션 id를 준다', () => {
    expect(readSessionId(cookie, SECRET)).toBe(sid);
  });

  it('**서명이 다르면 거부한다** — sid만 떼어 쓰면 아무 값이나 넣어 볼 수 있다', () => {
    expect(readSessionId(cookie, 'different-secret')).toBeNull();
  });

  it('서명되지 않은 값은 거부한다', () => {
    expect(readSessionId(`${SESSION_COOKIE}=${sid}`, SECRET)).toBeNull();
  });

  it('쿠키가 없거나 다른 쿠키만 있으면 `null`', () => {
    expect(readSessionId(undefined, SECRET)).toBeNull();
    expect(readSessionId('', SECRET)).toBeNull();
    expect(readSessionId('other=1', SECRET)).toBeNull();
  });

  it('다른 쿠키와 섞여 있어도 찾는다', () => {
    expect(readSessionId(`theme=dark; ${cookie}; x=1`, SECRET)).toBe(sid);
  });

  it('서명 문자열이 깨져 있어도 터지지 않는다', () => {
    expect(readSessionId(`${SESSION_COOKIE}=s%3Agarbage`, SECRET)).toBeNull();
  });
  void signed;
});

describe('readPageId', () => {
  const id = '3a1cbfb8-82bc-4923-a4d5-cf3bdf359845';

  it('경로에서 uuid를 꺼낸다', () => {
    expect(readPageId(`/api/ws/pages/${id}`)).toBe(id);
  });

  it('쿼리가 붙어도 꺼낸다', () => {
    expect(readPageId(`/api/ws/pages/${id}?v=1`)).toBe(id);
  });

  it('**uuid가 아니면 거부한다** — 이 값이 질의에 들어간다', () => {
    for (const bad of [`/api/ws/pages/../../etc`, `/api/ws/pages/1`, `/api/ws/pages/${id}x`, '/api/ws/pages/', '/other', undefined]) {
      expect(readPageId(bad)).toBeNull();
    }
  });

  it('다른 경로는 거부한다 — 이 게이트웨이는 페이지 편집만 받는다', () => {
    expect(readPageId(`/api/ws/spaces/${id}`)).toBeNull();
  });
});

describe('쿠키 파싱 경계', () => {
  const sid = 'abc123';
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(`s:${sign(sid, SECRET)}`)}`;

  it('공백이 많아도 찾는다', () => {
    expect(readSessionId(`  a=1 ;   ${cookie}  `, SECRET)).toBe(sid);
  });

  it('`=`가 없는 조각은 건너뛴다', () => {
    expect(readSessionId(`broken; ${cookie}`, SECRET)).toBe(sid);
  });

  it('같은 이름이 두 번 오면 **먼저 나온 것**을 쓴다 — 뒤에 덧붙여 덮어쓰지 못하게', () => {
    expect(readSessionId(`${cookie}; ${SESSION_COOKIE}=s%3Agarbage`, SECRET)).toBe(sid);
  });

  it('퍼센트 인코딩이 깨져 있어도 터지지 않는다', () => {
    expect(readSessionId(`${SESSION_COOKIE}=%E0%A4%A`, SECRET)).toBeNull();
  });

  it('이름만 있고 값이 없으면 `null`', () => {
    expect(readSessionId(`${SESSION_COOKIE}=`, SECRET)).toBeNull();
  });
});

/**
 * 연결한 사람의 주소 — 감사로그의 `ip` (P9_설계서_Gate D.6). HTTP 쪽 `req.ip`와 **같은 규칙**이어야 한다:
 * `WF_TRUST_PROXY`면 Express는 한 단계(nginx)를 믿는다 — 그 nginx가 덧붙인 **마지막** 항목이 연결한 사람이다.
 * 앞쪽 항목은 클라이언트가 적어 보낼 수 있다.
 */
describe('readClientIp (P9 D.6)', () => {
  it('프록시를 믿지 않으면 소켓의 주소다 — 헤더는 보지 않는다', () => {
    expect(readClientIp('10.0.0.9, 10.0.0.8', '::ffff:127.0.0.1', false)).toBe('::ffff:127.0.0.1');
  });

  it('프록시를 믿으면 X-Forwarded-For의 마지막 항목이다 — 앞쪽은 클라이언트가 꾸밀 수 있다', () => {
    expect(readClientIp('1.2.3.4, 10.0.0.8', '10.0.0.2', true)).toBe('10.0.0.8');
    expect(readClientIp(' 10.0.0.8 ', '10.0.0.2', true)).toBe('10.0.0.8');
  });

  it('프록시를 믿어도 헤더가 없으면 소켓의 주소다', () => {
    expect(readClientIp(undefined, '10.0.0.2', true)).toBe('10.0.0.2');
    expect(readClientIp('', '10.0.0.2', true)).toBe('10.0.0.2');
    expect(readClientIp(['10.0.0.7', '10.0.0.8'], '10.0.0.2', true)).toBe('10.0.0.8');
  });

  it('주소를 알 수 없으면 `null`', () => {
    expect(readClientIp(undefined, undefined, false)).toBeNull();
  });
});
