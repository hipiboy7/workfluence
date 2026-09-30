import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PASSWORD_RESET } from '@workfluence/shared';
import { linkExpiresAt, mailThrottled, newResetToken, passwordMark, resetLinkProblem, resetLinkUrl, resetMailAvailable, tokenDigest } from './reset-link';

/**
 * A등급 — **테스트 먼저** (3절, P19_설계서_Recovery C.3, FR-2003~2005·2008). 메일 재설정 링크의 값·기한·간격·쓸 수 있는가를 순수 함수로 판정한다 —
 * 시간과 무작위는 부르는 쪽이 넣는다
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const now = new Date('2026-09-30T01:00:00Z');
const min = 60_000;

describe('newResetToken · tokenDigest — 값과 그 해시 (A.1-5)', () => {
  it('**32바이트를 base64url 43자로** — 주소에 그대로 싣는다(`+`·`/`·`=`가 없다)', () => {
    const t = newResetToken(Buffer.alloc(PASSWORD_RESET.tokenBytes, 0xfb));
    expect(t).toHaveLength(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('**받은 바이트 수가 맞지 않으면 던진다** — 짧은 값은 추측할 수 있다', () => {
    expect(() => newResetToken(Buffer.alloc(16))).toThrow();
  });

  it('**서버에 두는 것은 SHA-256(16진)이다** — 값에서 해시로만 간다', () => {
    const t = newResetToken(Buffer.alloc(32, 7));
    expect(tokenDigest(t)).toBe(sha(t));
    expect(tokenDigest(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenDigest(t)).not.toContain(t);
  });
});

describe('passwordMark — 발급 뒤 비밀번호가 바뀌면 링크가 죽는다 (A.1-4)', () => {
  it('비밀번호 해시가 같으면 같고 다르면 다르다 — 해시 자체는 두지 않는다', () => {
    expect(passwordMark('$argon2id$v=19$a')).toBe(passwordMark('$argon2id$v=19$a'));
    expect(passwordMark('$argon2id$v=19$a')).not.toBe(passwordMark('$argon2id$v=19$b'));
    expect(passwordMark('$argon2id$v=19$a')).toMatch(/^[0-9a-f]{64}$/);
    expect(passwordMark('$argon2id$v=19$a')).not.toContain('argon2');
  });
});

describe('resetLinkUrl — 값은 주소의 # 뒤 (A.1-6)', () => {
  it('**`/reset-password#t=값`** — 공개 주소 끝의 `/`는 뗀다', () => {
    const t = 'A'.repeat(43);
    expect(resetLinkUrl('https://wiki.example.internal', t)).toBe(`https://wiki.example.internal/reset-password#t=${t}`);
    expect(resetLinkUrl('https://wiki.example.internal/', t)).toBe(`https://wiki.example.internal/reset-password#t=${t}`);
    expect(resetLinkUrl('https://wiki.example.internal/wiki//', t)).toBe(`https://wiki.example.internal/wiki/reset-password#t=${t}`);
  });

  it('**공개 주소가 없으면 링크를 만들 수 없다**(`null`) — 이 메일은 링크가 전부다', () => {
    expect(resetLinkUrl('', 'A'.repeat(43))).toBeNull();
    expect(resetLinkUrl('   ', 'A'.repeat(43))).toBeNull();
  });
});

describe('linkExpiresAt · mailThrottled — 30분, 한 계정에 5분에 한 통 (A.1-4·7)', () => {
  it('기한은 지금부터 30분 뒤', () => {
    expect(linkExpiresAt(now).getTime() - now.getTime()).toBe(PASSWORD_RESET.linkMinutes * min);
  });

  it('**마지막 발급이 5분 안이면 보내지 않는다** — 5분이 지나면 보낸다. 처음이면 보낸다', () => {
    expect(mailThrottled(null, now)).toBe(false);
    expect(mailThrottled(new Date(now.getTime() - 1 * min), now)).toBe(true);
    expect(mailThrottled(new Date(now.getTime() - PASSWORD_RESET.mailIntervalMinutes * min + 1), now)).toBe(true);
    expect(mailThrottled(new Date(now.getTime() - PASSWORD_RESET.mailIntervalMinutes * min), now)).toBe(false);
  });

  it('**시계가 뒤로 가 마지막 발급이 미래면 보내지 않는다** — 되풀이를 막는 쪽으로 틀린다', () => {
    expect(mailThrottled(new Date(now.getTime() + 10 * min), now)).toBe(true);
  });
});

describe('resetLinkProblem — 링크를 쓸 수 없는 까닭 (FR-2003·2007)', () => {
  const hash = '$argon2id$v=19$m=65536$abc';
  const link = { expiresAt: new Date(now.getTime() + 10 * min), passwordMark: passwordMark(hash) };
  const user = { passwordHash: hash, role: 'member' as const, status: 'active' as const, oidcSub: null };

  it('살아 있고 비밀번호가 그대로면 쓴다', () => {
    expect(resetLinkProblem(link, user, now)).toBeNull();
  });

  it('**기한이 지났으면** `expired` — 기한 그 순간도 지난 것이다', () => {
    expect(resetLinkProblem({ ...link, expiresAt: now }, user, now)).toBe('expired');
    expect(resetLinkProblem({ ...link, expiresAt: new Date(now.getTime() - 1) }, user, now)).toBe('expired');
  });

  it('**발급 뒤 비밀번호가 바뀌었으면** `changed` — 본인 변경·관리자 초기화·다른 링크 어느 길이든', () => {
    expect(resetLinkProblem(link, { ...user, passwordHash: '$argon2id$v=19$m=65536$other' }, now)).toBe('changed');
  });

  it('**그 사이 받을 수 없는 계정이 됐으면** `ineligible` — 정지·root가 됨·사내 계정·비밀번호 없음', () => {
    expect(resetLinkProblem(link, { ...user, status: 'suspended' }, now)).toBe('ineligible');
    expect(resetLinkProblem(link, { ...user, role: 'root' }, now)).toBe('ineligible');
    expect(resetLinkProblem(link, { ...user, oidcSub: 'idp-sub' }, now)).toBe('ineligible');
    expect(resetLinkProblem(link, { ...user, passwordHash: null }, now)).toBe('ineligible');
  });

  it('여럿이면 **기한이 먼저**다 — 까닭은 감사에만 남고 응답은 같다', () => {
    expect(resetLinkProblem({ ...link, expiresAt: now }, { ...user, role: 'root' }, now)).toBe('expired');
  });
});

describe('resetMailAvailable — 쓸 수 있는가 (FR-2008, A.1-9)', () => {
  const on = { mailEnabled: true, mailMock: false, publicUrl: 'https://wiki.example.internal', policy: 1 };

  it('메일이 켜져 있고, 공개 주소가 있고, 운영 설정이 켬이면 쓴다', () => {
    expect(resetMailAvailable(on)).toBe(true);
  });

  it('**하나라도 아니면 쓰지 않는다** — 메일이 꺼졌거나, 주소가 없거나, 관리자가 껐거나', () => {
    expect(resetMailAvailable({ ...on, mailEnabled: false })).toBe(false);
    expect(resetMailAvailable({ ...on, publicUrl: '' })).toBe(false);
    expect(resetMailAvailable({ ...on, publicUrl: '  ' })).toBe(false);
    expect(resetMailAvailable({ ...on, policy: 0 })).toBe(false);
  });

  it('**모의 발송이면 쓰지 않는다** — 보내는 척만 해 링크가 아무에게도 가지 않는다(운영은 기동이 막는다 — 개발·체험의 일, 병합 전 보안 검토 2 · 자체 점검 4)', () => {
    expect(resetMailAvailable({ ...on, mailMock: true })).toBe(false);
  });
});
