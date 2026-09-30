import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, COLLAB_LIMITS, NOTIFICATION_KINDS, PASSWORD_RESET, DB_POOL, LIST_PAGE_LIMIT, LIST_SEARCH_MAX, LLM_TIMINGS, LOG_EVENTS, PAGE_POSITION_GAP, PAGE_POSITION_LIMIT, PAGE_TREE_LOCK_WAIT_MS, RATE_LIMITS, REQUEST_ID_PATTERN, SPACE_LIST_MAX, TABLE_LIMITS, USER_LIST_MAX, USER_LIST_PAGE, USER_STATUSES } from './constants';

/** 설계 고정값 중 **이름의 모양**이 규칙인 것 (P11 D.4, FR-1214·1218) */

describe('LOG_EVENTS — 로그 줄의 안정된 event 코드', () => {
  it('**`영역.일` 두 마디, 소문자와 밑줄** — 문장을 고쳐도 코드는 그대로다', () => {
    for (const e of LOG_EVENTS) expect(e, e).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it('겹치지 않는다', () => {
    expect(new Set(LOG_EVENTS).size).toBe(LOG_EVENTS.length);
  });

  it('요청의 두 줄 — 접근 로그와 처리되지 않은 예외 — 가 있다', () => {
    expect(LOG_EVENTS).toContain('http.request');
    expect(LOG_EVENTS).toContain('http.unhandled');
  });

  it('영역은 정해진 것만 — 기동·요청·헬스·인증·세션·메일·LLM·실시간 편집', () => {
    const areas = new Set(LOG_EVENTS.map((e) => e.split('.')[0]));
    expect([...areas].sort()).toEqual(['app', 'auth', 'collab', 'health', 'http', 'llm', 'mail', 'session']);
  });

  it('**사내 IdP와의 처리가 실패하면 남는 줄이 있다** — 바깥 탓이라 warn이다 (FR-1215, P11 코드 리뷰)', () => {
    expect(LOG_EVENTS).toContain('auth.oidc_failed');
  });
});

describe('REQUEST_ID_PATTERN — 요청 식별자의 모양 (P11 D.2) — 앱이 받는 머리말과 감사 조회가 같은 판정을 쓴다', () => {
  it('nginx의 32자 16진과 앱의 UUID를 받는다', () => {
    for (const ok of ['c4f74de7a73ff592ec5ec63e597de58b', '8ca77575-3994-4302-8f0f-73e0f7a91839', 'req-0001']) expect(REQUEST_ID_PATTERN.test(ok), ok).toBe(true);
  });

  it('**줄바꿈·따옴표·공백**, 8자 미만·64자 초과는 받지 않는다 — 로그 줄을 꾸미는 값이다', () => {
    for (const bad of ['bad id "x"', 'abc\ndef-ghij', 'short', 'x'.repeat(65), '', 'abcdefgh ']) expect(REQUEST_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('AUDIT_ACTIONS — P11', () => {
  it('위임을 바꾸면 남는다 (FR-1205)', () => {
    expect(AUDIT_ACTIONS).toContain('user.grants.change');
  });
});

describe('상한 (P12 A.1-2·4·5)', () => {
  it('**늦어진다고 알리는 때는 5초** — 사용자가 정한 값이다', () => {
    expect(LLM_TIMINGS.slowAnswerMs).toBe(5_000);
  });

  it('실시간 편집 한 프레임은 16MiB — REST 저장 상한(2MB)의 문서가 Yjs로 약 2MB라 8배를 둔다', () => {
    expect(COLLAB_LIMITS.maxFrameBytes).toBe(16 * 1024 * 1024);
    expect(COLLAB_LIMITS.maxFrameBytes).toBeGreaterThanOrEqual(8 * 2 * 1024 * 1024);
  });

  it('**저장하고 보기로의 스냅숏은 1MiB(base64 글자)까지** — JSON 본문 상한(2MB, `main.ts`)에 제목과 함께 든다. 지운 기록은 한 편집 기간(방이 열려 있는 동안)만 쌓인다 (P13 D.7)', () => {
    expect(COLLAB_LIMITS.maxFlushSnapshotChars).toBe(1024 * 1024);
    expect(COLLAB_LIMITS.maxFlushSnapshotChars).toBeLessThan(2 * 1024 * 1024);
  });

  it('표 칸의 합치는 수는 HTML 표준이 읽는 상한(1000)까지, 열 너비는 10000px까지', () => {
    expect(TABLE_LIMITS).toEqual({ maxSpan: 1000, maxColWidthPx: 10_000 });
  });
});

describe('사용자 상태와 감사 종류 — P13 계정 정지 (FR-1440·1444)', () => {
  it('정지(`suspended`)가 사용자 상태에 있다 — 승인 대기·활성과 같은 축이다', () => {
    expect(USER_STATUSES).toEqual(['pending', 'active', 'suspended']);
  });

  it('정지·정지 해제가 감사 종류에 있다', () => {
    expect(AUDIT_ACTIONS).toContain('user.suspend');
    expect(AUDIT_ACTIONS).toContain('user.unsuspend');
  });

  it('**실시간 편집의 제목 바꾸기가 감사 종류에 있다** — 바꾼 사람을 남긴다. 뒤에 다른 사람이 치면 저장의 작성자는 그 사람이 된다 (병합 전 보안 검토 L2)', () => {
    expect(AUDIT_ACTIONS).toContain('page.collab.title');
  });

  it('사용자 목록은 한 번에 100명 — 서버의 기본값과 화면의 "더 보기"가 같은 값을 쓴다 (병합 전 자체 점검 14)', () => {
    expect(USER_LIST_PAGE).toBe(100);
  });

  it('**한 번에 받을 수 있는 상한은 300명 규모를 한 번에 담는다** — 조치 뒤에 보던 만큼 다시 읽는다 (병합 전 코드 리뷰 10)', () => {
    expect(USER_LIST_MAX).toBeGreaterThanOrEqual(3 * USER_LIST_PAGE);
  });
});

describe('RATE_LIMITS — IP별 요청 제한', () => {
  it('**비밀번호 변경도 센다 — 분당 5건** (P13 좁은 자체 점검 6). 변경은 그 계정의 로그인과 같은 줄에 서서(D.4), 제한이 없으면 세션을 쥔 사람이 틀린 현재 비밀번호로 그 계정의 로그인과 변경을 뒤로 민다. 성공은 돌려준다(로그인과 같다)', () => {
    expect(RATE_LIMITS.changePassword).toEqual({ max: 5, windowSec: 60 });
  });

  it('**비밀번호를 잊었을 때의 세 요청** (P19 FR-2011) — 메일 재설정 요청·email 확인 요청은 관리자 요청과 같이 10분에 3건, 링크 쓰기는 10분에 10건(틀린 비밀번호 규칙으로 다시 누를 수 있게)', () => {
    expect(RATE_LIMITS.resetMail).toEqual({ max: 3, windowSec: 600 });
    expect(RATE_LIMITS.emailHelp).toEqual({ max: 3, windowSec: 600 });
    expect(RATE_LIMITS.resetPassword).toEqual({ max: 10, windowSec: 600 });
    expect(RATE_LIMITS.recoverPassword).toEqual({ max: 3, windowSec: 600 });
  });
});

describe('PASSWORD_RESET — 메일 재설정 링크 (P19 A.1-4·5·7)', () => {
  it('**30분 · 한 계정에 5분에 한 통 · 값은 32바이트**', () => {
    expect(PASSWORD_RESET).toEqual({ linkMinutes: 30, mailIntervalMinutes: 5, tokenBytes: 32 });
  });

  it('간격이 기한보다 짧다 — 기한 안에 다시 받을 수 있다', () => {
    expect(PASSWORD_RESET.mailIntervalMinutes).toBeLessThan(PASSWORD_RESET.linkMinutes);
  });
});

describe('NOTIFICATION_KINDS (P19 FR-2009)', () => {
  it('**email 확인 요청**이 있다 — 시스템 관리자만 받는다', () => {
    expect(NOTIFICATION_KINDS).toEqual(['mention', 'password.reset.request', 'email.confirm.request']);
  });

  it('감사 행위에 세 요청이 있다 — 메일 재설정 요청·링크 쓰기·email 확인 요청', () => {
    for (const a of ['auth.password.reset.request', 'auth.password.reset', 'auth.email.help']) expect(AUDIT_ACTIONS as readonly string[]).toContain(a);
  });

  it('응답 뒤에 도는 일이 실패하면 남는 줄이 있다 — 우리 쪽 결함이라 error (FR-2012)', () => {
    expect(LOG_EVENTS).toContain('auth.reset_mail_failed');
    expect(LOG_EVENTS).toContain('auth.email_help_failed');
  });

  it('화면 설정(`/api/auth/config`)이 운영 설정을 읽지 못하면 메일 재설정만 끄고 줄을 남긴다 — 우리 쪽 결함이라 error (병합 전 코드 리뷰 5)', () => {
    expect(LOG_EVENTS).toContain('auth.config_failed');
  });
});

describe('스페이스 목록의 상한 (P14 FR-1514)', () => {
  it('**한 번에 500개까지** — 서버의 목록 조건과 관리 화면의 "찾기로 좁힌다" 안내가 이 값 하나를 쓴다. 기본 쪽(200)보다 크다', () => {
    expect(SPACE_LIST_MAX).toBe(500);
    expect(SPACE_LIST_MAX).toBeGreaterThan(LIST_PAGE_LIMIT);
  });
});

describe('페이지 트리의 자리와 잠금 (P14 D.1 — 병합 전 검토)', () => {
  it('**자리 간격은 2의 거듭제곱** — 이웃 사이 가운데를 거듭 잡아도 정수로 여러 번 나뉜다', () => {
    expect(PAGE_POSITION_GAP).toBe(1024);
    expect(Number.isInteger(Math.log2(PAGE_POSITION_GAP))).toBe(true);
  });

  it('**자리 한도는 int4 안** — 한도에서 한 간격을 더해도 넘치지 않는다', () => {
    expect(PAGE_POSITION_LIMIT + PAGE_POSITION_GAP).toBeLessThan(2 ** 31);
    expect(PAGE_POSITION_LIMIT).toBeGreaterThan(PAGE_POSITION_GAP * 1000);
  });

  it('**트리 잠금은 오래 기다리지 않는다** — 연결을 쥔 채 기다리므로 연결 대기 한도보다 훨씬 짧다', () => {
    expect(PAGE_TREE_LOCK_WAIT_MS).toBe(2000);
    expect(PAGE_TREE_LOCK_WAIT_MS * 4).toBeLessThanOrEqual(DB_POOL.connectionTimeoutMillis);
  });

  it('목록 찾기 글자는 100자까지 — 사용자·스페이스 찾기와 화면의 입력 칸이 같이 쓴다', () => {
    expect(LIST_SEARCH_MAX).toBe(100);
  });
});

