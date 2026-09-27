import { describe, expect, it } from 'vitest';
import { emptyDocument } from './document';
import {
  addMemberDto,
  attachLabelDto,
  auditQueryDto,
  isUuid,
  userGrantsDto,
  changePasswordDto,
  collabTitleDto,
  flushCollabDto,
  listUsersDto,
  createCategoryDto,
  createPageDto,
  createSpaceDto,
  createTemplateDto,
  createUserDto,
  createLlmPromptDto,
  createLlmProviderDto,
  findIdDto,
  llmAskDto,
  loginDto,
  movePageDto,
  updateTemplateDto,
  recoverPasswordDto,
  searchQueryDto,
  signupDto,
  spaceListQueryDto,
  spaceStatusDto,
  updateLlmPromptDto,
  updatePageDto,
  updateSpaceDto,
} from './schemas';
import { COLLAB_LIMITS, LLM_LIMITS, SPACE_LIST_MAX, USER_LIST_MAX, USER_LIST_PAGE } from './constants';

const uuid = '0f6b2c1e-6d4a-4c3b-9a8e-1b2c3d4e5f60';

describe('인증·계정 DTO', () => {
  it('loginDto: 공백 제거, 빈 값 거부', () => {
    expect(loginDto.parse({ username: '  admin ', password: 'x' })).toEqual({ username: 'admin', password: 'x' });
    expect(loginDto.safeParse({ username: '', password: 'x' }).success).toBe(false);
  });

  it('signupDto: 사용자명 규칙, email 정규화, 비밀번호는 **바닥(8자)만** 계약이 본다', () => {
    const ok = signupDto.parse({ username: 'hong.gd', displayName: '홍길동', email: ' Hong.GD@Example.Internal ', password: 'abcd1234' });
    expect(ok.email).toBe('hong.gd@example.internal');
    expect(signupDto.safeParse({ username: 'Bad Name', displayName: 'x', email: 'a@b.co', password: 'abcd1234' }).success).toBe(false);
    expect(signupDto.safeParse({ username: 'ok', displayName: 'x', email: 'not-an-email', password: 'abcd1234' }).success).toBe(false);
    // 8자·1종은 **계약을 통과한다.** 문자 종류는 운영이 조절하는 값이라 서비스가
    // 살아 있는 정책값으로 본다 — 여기서 굳히면 관리자가 낮춰도 영영 안 먹는다 (P4 자체 점검 2)
    expect(signupDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abcdefgh' }).success).toBe(true);
    // 바닥은 계약이 막는다
    const short = signupDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abc1' });
    expect(short.success).toBe(false);
    if (!short.success) expect(short.error.issues.map((i) => i.message)).toContain('8자 이상');
  });

  it('findIdDto는 email과 이름을 둘 다 요구한다', () => {
    expect(findIdDto.safeParse({ email: 'a@b.co' }).success).toBe(false);
    expect(findIdDto.safeParse({ email: 'a@b.co', displayName: '홍길동' }).success).toBe(true);
  });

  it('recoverPasswordDto / changePasswordDto', () => {
    expect(recoverPasswordDto.safeParse({ username: 'hong', email: 'a@b.co' }).success).toBe(true);
    expect(changePasswordDto.safeParse({ currentPassword: 'old-pass1', newPassword: 'new-pass1' }).success).toBe(true);
    expect(changePasswordDto.safeParse({ currentPassword: 'same-pass1', newPassword: 'same-pass1' }).success).toBe(false);
    expect(changePasswordDto.safeParse({ currentPassword: 'old', newPassword: 'short' }).success).toBe(false);
  });

  it('createUserDto: 역할은 root·admin·member', () => {
    expect(createUserDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abcd1234', role: 'admin' }).success).toBe(true);
    expect(createUserDto.safeParse({ username: 'ok', displayName: 'x', email: 'a@b.co', password: 'abcd1234', role: 'superuser' }).success).toBe(false);
  });
});

describe('카테고리·스페이스 DTO', () => {
  it('createCategoryDto', () => {
    expect(createCategoryDto.parse({ name: ' 운영 ' })).toEqual({ name: '운영' });
    expect(createCategoryDto.safeParse({ name: '' }).success).toBe(false);
  });

  it('createSpaceDto: 종류 필수, 카테고리 선택, description 기본값', () => {
    expect(createSpaceDto.parse({ name: '문서', kind: 'team', categoryId: uuid })).toEqual({ name: '문서', kind: 'team', categoryId: uuid, description: '' });
    expect(createSpaceDto.parse({ name: '내 공간', kind: 'personal' }).categoryId).toBeNull();
    expect(createSpaceDto.safeParse({ name: '문서', kind: 'group' }).success).toBe(false);
    expect(createSpaceDto.safeParse({ name: '문서', kind: 'team', categoryId: 'nope' }).success).toBe(false);
  });

  it('updateSpaceDto / spaceStatusDto / addMemberDto / spaceListQueryDto', () => {
    expect(updateSpaceDto.parse({ name: '새 이름' })).toEqual({ name: '새 이름' });
    expect(spaceStatusDto.safeParse({ status: 'suspended' }).success).toBe(true);
    expect(spaceStatusDto.safeParse({ status: 'deleted' }).success).toBe(false);
    expect(addMemberDto.safeParse({ username: 'kim', role: 'viewer' }).success).toBe(true);
    expect(addMemberDto.safeParse({ username: 'kim', role: 'owner' }).success).toBe(false);
    expect(spaceListQueryDto.parse({})).toEqual({ scope: 'personal', limit: 200 });
    expect(spaceListQueryDto.parse({ scope: 'all', limit: '5' })).toEqual({ scope: 'all', limit: 5 });
  });

  /** **모든 스페이스는 서버가 찾고 거른다** (P14 FR-1514, P4 FR-537 상한 + 검색). 화면에서만 거르면 상한 밖의 스페이스를 찾지 못한다(T-051) */
  it('spaceListQueryDto — 찾기(`q`)와 상태(`status`)', () => {
    expect(spaceListQueryDto.parse({ scope: 'all', q: '  운영팀  ', status: 'suspended' })).toEqual({ scope: 'all', limit: 200, q: '운영팀', status: 'suspended' });
    expect(spaceListQueryDto.parse({ scope: 'all', q: 'x'.repeat(100) }).q).toHaveLength(100);
    expect(spaceListQueryDto.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(spaceListQueryDto.safeParse({ status: 'deleted' }).success).toBe(false);
    // 빈 찾기는 찾지 않는 것이다 — 모두 보인다
    expect(spaceListQueryDto.parse({ q: '   ' })).toEqual({ scope: 'personal', limit: 200 });
    // 상한은 공유 상수 하나다 — 관리 화면이 그 값으로 "찾기로 좁힌다"를 말한다
    expect(spaceListQueryDto.parse({ limit: SPACE_LIST_MAX }).limit).toBe(SPACE_LIST_MAX);
    expect(spaceListQueryDto.safeParse({ limit: SPACE_LIST_MAX + 1 }).success).toBe(false);
  });
});

describe('페이지·검색 DTO', () => {
  it('createPageDto: 본문을 문서 검증기로 검사하고 parentId 기본값은 null', () => {
    const ok = createPageDto.parse({ spaceId: uuid, title: '제목', content: emptyDocument() });
    expect(ok.parentId).toBeNull();
    const bad = createPageDto.safeParse({ spaceId: uuid, title: '제목', content: { type: 'doc', content: [{ type: 'script' }] } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toContain('본문 검증 실패');
    expect(createPageDto.safeParse({ spaceId: 'not-uuid', title: '제목', content: emptyDocument() }).success).toBe(false);
  });

  it('updatePageDto: baseVersionNo는 양의 정수', () => {
    expect(updatePageDto.safeParse({ title: 't', content: emptyDocument(), baseVersionNo: 3 }).success).toBe(true);
    expect(updatePageDto.safeParse({ title: 't', content: emptyDocument(), baseVersionNo: 0 }).success).toBe(false);
    expect(updatePageDto.safeParse({ title: 't', content: emptyDocument() }).success).toBe(false);
  });

  it('movePageDto / searchQueryDto', () => {
    expect(movePageDto.parse({ parentId: null, position: 0 })).toEqual({ parentId: null, position: 0 });
    expect(movePageDto.safeParse({ parentId: uuid, position: -1 }).success).toBe(false);
    expect(searchQueryDto.parse({ q: ' 배포 ' })).toEqual({ q: '배포', limit: 20 });
    expect(searchQueryDto.parse({ q: 'x', limit: '5' }).limit).toBe(5);
    expect(searchQueryDto.safeParse({ q: 'x', limit: '500' }).success).toBe(false);
  });
});

describe('템플릿 DTO (P6 FR-740~745)', () => {
  const doc = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph' }] };

  it('이름과 본문이 있으면 통과한다', () => {
    expect(createTemplateDto.safeParse({ name: '회의록', content: doc }).success).toBe(true);
  });

  it('이름이 비면 거부한다', () => {
    expect(createTemplateDto.safeParse({ name: '  ', content: doc }).success).toBe(false);
  });

  it('**본문도 문서 스키마를 통과해야 한다** (FR-742) — 템플릿이 깨져 있으면 그것으로 만든 문서가 다 깨진다', () => {
    expect(createTemplateDto.safeParse({ name: 'x', content: { type: 'doc', content: [{ type: 'iframe' }] } }).success).toBe(false);
  });

  it('고치기는 한 가지만 줘도 된다', () => {
    for (const patch of [{ name: '새 이름' }, { description: '설명' }, { content: doc }]) {
      expect(updateTemplateDto.safeParse(patch).success).toBe(true);
    }
  });

  it('**빈 몸통은 거부한다** — 아무것도 안 바꾸는 요청이 200을 받으면 화면은 바뀐 줄 안다', () => {
    const r = updateTemplateDto.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('바꿀 것을');
  });
});

/** Phase 10 (P10_설계서_Llm F절). 테스트를 먼저 썼다 */
describe('LLM DTO', () => {
  it('등록은 주소를 **판정한 모양으로** 받는다 — 화면과 서버가 같은 함수를 쓴다 (FR-1104)', () => {
    const r = createLlmProviderDto.parse({ name: ' 사내 Qwen ', baseUrl: 'http://llm.example.internal:8000/v1/', model: 'Qwen/Qwen3-32B' });
    expect(r).toEqual({ name: '사내 Qwen', baseUrl: 'http://llm.example.internal:8000/v1', model: 'Qwen/Qwen3-32B', apiKey: null });
    expect(createLlmProviderDto.safeParse({ name: 'a', baseUrl: 'http://u:p@llm.example.internal/v1', model: 'm' }).success).toBe(false);
    expect(createLlmProviderDto.safeParse({ name: 'a', baseUrl: 'ftp://llm.example.internal/v1', model: 'm' }).success).toBe(false);
  });

  it('키는 없어도 되고, **빈 키는 없는 키다**', () => {
    const base = { name: 'a', baseUrl: 'http://llm.example.internal/v1', model: 'm' };
    expect(createLlmProviderDto.parse({ ...base, apiKey: '  ' }).apiKey).toBeNull();
    expect(createLlmProviderDto.parse({ ...base, apiKey: 'k-123' }).apiKey).toBe('k-123');
    expect(createLlmProviderDto.safeParse({ ...base, apiKey: 'k\nX-Evil: 1' }).success).toBe(false);
  });

  it('이름·모델이 비면 거부한다', () => {
    expect(createLlmProviderDto.safeParse({ name: ' ', baseUrl: 'http://llm.example.internal/v1', model: 'm' }).success).toBe(false);
    expect(createLlmProviderDto.safeParse({ name: 'a', baseUrl: 'http://llm.example.internal/v1', model: '' }).success).toBe(false);
  });

  it('지시문: 이름과 본문 — 본문 상한', () => {
    expect(createLlmPromptDto.parse({ name: ' 요약 ', content: '세 줄로 요약한다' })).toEqual({ name: '요약', content: '세 줄로 요약한다' });
    expect(createLlmPromptDto.safeParse({ name: '요약', content: '   ' }).success).toBe(false);
    expect(createLlmPromptDto.safeParse({ name: '요약', content: 'x'.repeat(LLM_LIMITS.promptMaxChars + 1) }).success).toBe(false);
  });

  it('지시문 고치기는 하나만 줘도 되고 **빈 몸통은 거부한다**', () => {
    expect(updateLlmPromptDto.safeParse({ name: '새 이름' }).success).toBe(true);
    expect(updateLlmPromptDto.safeParse({ content: '새 본문' }).success).toBe(true);
    expect(updateLlmPromptDto.safeParse({}).success).toBe(false);
  });

  it('질문: 앞뒤 공백을 벗기고, 비었거나 너무 길면 거부한다 (FR-1116)', () => {
    expect(llmAskDto.parse({ providerId: uuid, question: '  안녕  ' })).toEqual({ providerId: uuid, question: '안녕' });
    expect(llmAskDto.safeParse({ providerId: uuid, question: '  ' }).success).toBe(false);
    expect(llmAskDto.safeParse({ providerId: uuid, question: 'x'.repeat(LLM_LIMITS.questionMaxChars + 1) }).success).toBe(false);
    expect(llmAskDto.safeParse({ providerId: 'nope', question: 'a' }).success).toBe(false);
  });

  it('**지시문은 새 대화에서만 고른다** (FR-1127) — 이어 묻는 대화에 주면 거부한다', () => {
    expect(llmAskDto.safeParse({ providerId: uuid, promptId: uuid, question: 'a' }).success).toBe(true);
    expect(llmAskDto.safeParse({ providerId: uuid, conversationId: uuid, question: 'a' }).success).toBe(true);
    expect(llmAskDto.safeParse({ providerId: uuid, conversationId: uuid, promptId: uuid, question: 'a' }).success).toBe(false);
  });
});

/** 검토 반영 (P10 보안 검토 3 · 코드 리뷰 10·15). 테스트를 먼저 썼다 */
describe('LLM DTO — PostgreSQL이 받지 않는 글자와 키의 모양', () => {
  const base = { name: 'a', baseUrl: 'http://llm.example.internal/v1', model: 'm' };

  it('**U+0000을 받지 않는다** — PostgreSQL text가 거부해 저장이 실패하고, 그 오류 문장에 본문이 실린다', () => {
    expect(llmAskDto.safeParse({ providerId: uuid, question: 'a\u0000b' }).success).toBe(false);
    expect(createLlmPromptDto.safeParse({ name: '요약', content: '지시\u0000' }).success).toBe(false);
    expect(createLlmPromptDto.safeParse({ name: '요\u0000약', content: '지시' }).success).toBe(false);
    expect(updateLlmPromptDto.safeParse({ content: 'x\u0000' }).success).toBe(false);
    expect(createLlmProviderDto.safeParse({ ...base, name: 'a\u0000' }).success).toBe(false);
    expect(createLlmProviderDto.safeParse({ ...base, model: 'm\u0000' }).success).toBe(false);
  });

  it('**API 키는 보이는 ASCII만** — 폭 없는 빈칸·한글·NUL이 섞인 키는 모든 요청을 "닿지 않는다"로 오진하게 만든다', () => {
    // 기호(`-`·`.`·`_`)가 든 키는 받는다. 시험의 키는 실제 키 모양을 흉내 내지 않는다(12.3절, T-045)
    expect(createLlmProviderDto.parse({ ...base, apiKey: 'aaaa-bbbb.cc_dd' }).apiKey).toBe('aaaa-bbbb.cc_dd');
    for (const bad of ['k\u200b', '키값', 'k\u0000', 'a b', 'k\t1']) {
      expect(createLlmProviderDto.safeParse({ ...base, apiKey: bad }).success).toBe(false);
    }
  });
});

describe('주소에 들어가는 값 (P10 종료 루틴 — 경로 조작)', () => {
  it('**식별자 모양** — 서버의 `UuidPipe`와 화면의 경로 지킴이 같은 판정을 쓴다', () => {
    expect([isUuid('3f2a7b1c-9d4e-4f60-8a1b-2c3d4e5f6a7b'), isUuid('00000000-0000-4000-8000-000000000000')]).toEqual([true, true]);
    for (const bad of ['', 'x', '3f2a7b1c-9d4e-4f60-8a1b-2c3d4e5f6a7b/labels/x', '../../api/users', undefined, null, 7]) {
      expect(isUuid(bad), String(bad)).toBe(false);
    }
  });

  it('**라벨 이름은 `.`·`..`일 수 없다** — 라벨 페이지의 API 경로에서 URL 해석이 점 조각으로 읽어 다른 API를 가리킨다', () => {
    for (const name of ['.', '..', ' .. ']) expect(attachLabelDto.safeParse({ name }).success, name).toBe(false);
    for (const name of ['...', 'v1.0', '.net']) expect(attachLabelDto.safeParse({ name }).success, name).toBe(true);
  });
});

describe('감사 조회 DTO — 요청 번호로 거른다 (P11 FR-1212, 코드 리뷰 10)', () => {
  it('**로그 한 줄의 `requestId`로** 감사 행을 찾는다 — 로그에서 복사해 붙인 앞뒤 공백은 뗀다', () => {
    expect(auditQueryDto.parse({ requestId: ' c4f74de7a73ff592ec5ec63e597de58b ' }).requestId).toBe('c4f74de7a73ff592ec5ec63e597de58b');
    expect(auditQueryDto.parse({}).requestId).toBeUndefined();
  });

  it('모양이 틀리면 받지 않는다 — 요청 번호가 아니다', () => {
    for (const bad of ['bad id "x"', 'short', 'x'.repeat(65)]) expect(auditQueryDto.safeParse({ requestId: bad }).success, bad).toBe(false);
  });
});

describe('위임 목록 DTO (P11 F절)', () => {
  it('위임할 수 있는 행위의 목록 전체를 받는다 — 비우면 거둔다', () => {
    expect(userGrantsDto.parse({ grants: ['llm.manage'] })).toEqual({ grants: ['llm.manage'] });
    expect(userGrantsDto.parse({ grants: [] })).toEqual({ grants: [] });
  });

  it('**위임할 수 없는 행위·겹친 것·다른 키는 받지 않는다**', () => {
    for (const bad of [{ grants: ['system.manage'] }, { grants: ['llm.manage', 'llm.manage'] }, { grants: 'llm.manage' }, {}, { grants: [], role: 'root' }]) {
      expect(userGrantsDto.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

/**
 * **사용자 목록의 찾기·거르기·나누기** (P13 C.6, FR-1450~1452). 기본 100에서 조용히 끊겨 300명 규모에서 200명을 화면에서 관리하지
 * 못했다. 서버가 찾고 거르고 나눈다
 */
describe('listUsersDto (P13 FR-1450~1452)', () => {
  it('비면 처음 100명', () => {
    expect(listUsersDto.parse({})).toEqual({ limit: 100, offset: 0 });
  });

  it('찾는 말은 앞뒤를 잘라 100자까지', () => {
    expect(listUsersDto.parse({ q: '  앨리스  ' }).q).toBe('앨리스');
    expect(() => listUsersDto.parse({ q: 'x'.repeat(101) })).toThrow();
  });

  it('상태는 승인 대기·활성·잠김·정지만', () => {
    for (const status of ['pending', 'active', 'locked', 'suspended']) expect(listUsersDto.parse({ status }).status).toBe(status);
    expect(() => listUsersDto.parse({ status: 'deleted' })).toThrow();
  });

  it('쿼리 문자열의 숫자를 읽는다 — 한 번에 500명까지, 건너뛰기는 0 이상', () => {
    expect(listUsersDto.parse({ limit: '50', offset: '100' })).toMatchObject({ limit: 50, offset: 100 });
    expect(() => listUsersDto.parse({ limit: '501' })).toThrow();
    expect(() => listUsersDto.parse({ offset: '-1' })).toThrow();
  });

  it('상한은 공유 상수다 — 화면이 같은 값으로 줄인다 (병합 전 코드 리뷰 10)', () => {
    expect(listUsersDto.parse({ limit: String(USER_LIST_MAX) }).limit).toBe(USER_LIST_MAX);
    expect(() => listUsersDto.parse({ limit: String(USER_LIST_MAX + 1) })).toThrow();
    expect(listUsersDto.parse({}).limit).toBe(USER_LIST_PAGE);
  });
});

/** **실시간 편집의 제목** (P13 FR-1460) — 입력을 멈추면 방에 알린다. 제목 칸과 같은 규칙이다 */
describe('collabTitleDto (P13 FR-1460)', () => {
  it('앞뒤를 자르고 1~300자', () => {
    expect(collabTitleDto.parse({ title: '  회의록  ' })).toEqual({ title: '회의록' });
    expect(() => collabTitleDto.parse({ title: '   ' })).toThrow();
    expect(() => collabTitleDto.parse({ title: 'x'.repeat(301) })).toThrow();
    expect(() => collabTitleDto.parse({})).toThrow();
  });
});

/**
 * **저장하고 보기로의 스냅숏** (P13 D.7 — 병합 전 자체 점검 8, 좁은 자체 점검 2). 화면이 자기 문서의 스냅숏(Yjs가 "누구의 몇 번째까지 가졌고
 * 무엇을 지웠나"를 적는 값)을 함께 보내면 서버가 그만큼 받았는지 본다 — 끊긴 줄 모르는 연결에서 누르면 "이미 남아 있다"로 보기로 넘어가 보내지
 * 못한 입력이 사라졌다. 처음에는 상태 벡터(`sv`)만 보냈는데, 지우기는 상태 벡터를 올리지 않아 **지우기만 한 입력**은 닿지 않아도 "저장됨"이었다
 */
describe('flushCollabDto — 스냅숏 (P13 D.7)', () => {
  it('base64로 온다 — 없어도 된다', () => {
    expect(flushCollabDto.parse({ snapshot: 'AAEBAQ==' })).toEqual({ snapshot: 'AAEBAQ==' });
    expect(flushCollabDto.parse({})).toEqual({});
    expect(flushCollabDto.parse({ title: '제목', snapshot: '' })).toEqual({ title: '제목', snapshot: '' });
  });

  it('**상태 벡터만 싣던 `sv`는 읽지 않는다** — 지운 기록이 없어 판정이 반쪽이다', () => {
    expect(flushCollabDto.parse({ sv: 'AQKGAQE=' })).toEqual({});
  });

  it('base64가 아니거나 상한(`COLLAB_LIMITS.maxFlushSnapshotChars`)을 넘으면 받지 않는다', () => {
    for (const bad of ['not base64!', 'AQ==AQ', '*'.repeat(8)]) expect(() => flushCollabDto.parse({ snapshot: bad }), bad).toThrow();
    const max = COLLAB_LIMITS.maxFlushSnapshotChars;
    expect(flushCollabDto.parse({ snapshot: 'A'.repeat(max) }).snapshot).toHaveLength(max);
    expect(() => flushCollabDto.parse({ snapshot: 'A'.repeat(max + 1) })).toThrow();
  });
});
