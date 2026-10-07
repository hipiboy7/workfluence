import { describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, MARKDOWN_LIMITS } from './constants';
import type { DocNode } from './document';
import type { SpaceView } from './schemas';
import {
  bodyToDoc,
  docToBody,
  matchMember,
  matchSpaces,
  toV1Category,
  toV1Member,
  toV1Space,
  v1AddMemberDto,
  v1CategoryDto,
  v1CreatePageDto,
  v1CreateSpaceDto,
  v1ErrorBody,
  v1MemberRoleDto,
  v1MovePageDto,
  v1PageQuery,
  v1SpaceListQuery,
  v1SpaceStatusDto,
  v1UpdatePageDto,
  v1UpdateSpaceDto,
  V1_DEFAULTS,
} from './v1';

/**
 * A등급 — **테스트 먼저** (docs/spinoff/public-api 설계서 3.3·3.5절 · FR-2211·2215·2223~2225).
 *
 * 공개 API(v1)의 에이전트용 단순 계약: 필수는 **어디(스페이스)·제목·본문**뿐이고 나머지는 기본값이다. 이 파일은 그 순수한 부분을 본다 — 입력 스키마,
 * 본문 형식 변환, 오류의 모양, 이름으로 스페이스 찾기.
 */

const UUID = '3b1c8f06-6f0e-4b52-9f63-0c9b2a8c7d11';
const doc = (text: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

describe('기본값 — 한 곳 (FR-2224)', () => {
  it('에이전트 기본은 마크다운이고 목록 상한이 있다', () => {
    expect(V1_DEFAULTS.writeFormat).toBe('markdown');
    expect(V1_DEFAULTS.readFormat).toBe('markdown');
    expect(V1_DEFAULTS.listLimit).toBeGreaterThan(0);
  });
});

describe('bodyToDoc — 본문 형식 (FR-2215)', () => {
  it('markdown: 글자를 문서로 바꾼다', () => {
    const r = bodyToDoc('markdown', '## 증상\n- 지연');
    expect(r.ok && r.doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
  });

  it('markdown인데 글자가 아니면 거절한다', () => {
    expect(bodyToDoc('markdown', { type: 'doc' })).toEqual({ ok: false, errors: [expect.stringMatching(/글자/)] });
  });

  it('markdown 변환 오류는 그대로 전한다 (줄 번호·규칙)', () => {
    const r = bodyToDoc('markdown', '가\n<b>');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join(' ')).toMatch(/2행.*HTML/);
  });

  it('json: 문서를 정본 검증으로 거른다', () => {
    expect(bodyToDoc('json', doc('안녕'))).toEqual({ ok: true, doc: doc('안녕') });
    const bad = bodyToDoc('json', { type: 'doc', content: [{ type: 'script' }] });
    expect(bad.ok).toBe(false);
  });

  it('json인데 객체가 아니면 거절한다', () => {
    expect(bodyToDoc('json', '## 글').ok).toBe(false);
  });
});

describe('docToBody — 읽기 형식', () => {
  const d: DocNode = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '제목' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '굵게', marks: [{ type: 'bold' }] }] },
    ],
  };

  it('markdown·text·json', () => {
    expect(docToBody('markdown', d)).toBe('## 제목\n\n**굵게**');
    expect(docToBody('text', d)).toContain('굵게');
    expect(docToBody('json', d)).toBe(d);
  });
});

describe('v1CreatePageDto — 필수는 어디·제목·본문뿐 (FR-2223)', () => {
  it('셋만으로 통과하고 기본값이 채워진다', () => {
    const r = v1CreatePageDto.parse({ space: '장애 보고', title: '10/7 장애', body: '## 증상' });
    expect(r.space).toBe('장애 보고');
    expect(r.title).toBe('10/7 장애');
    expect(r.parentId).toBeNull();
    expect(r.doc.type).toBe('doc');
  });

  it('스페이스 이름 앞뒤 빈칸·제목 앞뒤 빈칸은 뗀다', () => {
    const r = v1CreatePageDto.parse({ space: '  팀 공간 ', title: '  제목  ', body: '글' });
    expect([r.space, r.title]).toEqual(['팀 공간', '제목']);
  });

  it('부모는 고르면 쓰고(id), 없으면 맨 위', () => {
    expect(v1CreatePageDto.parse({ space: 's', title: 't', body: 'b', parentId: UUID }).parentId).toBe(UUID);
    expect(v1CreatePageDto.parse({ space: 's', title: 't', body: 'b', parentId: null }).parentId).toBeNull();
  });

  it('format: json이면 본문은 문서', () => {
    const r = v1CreatePageDto.parse({ space: 's', title: 't', body: doc('x'), format: 'json' });
    expect(r.doc).toEqual(doc('x'));
  });

  it.each([
    ['스페이스 없음', { title: 't', body: 'b' }],
    ['제목 없음', { space: 's', body: 'b' }],
    ['본문 없음', { space: 's', title: 't' }],
    ['빈 제목', { space: 's', title: '  ', body: 'b' }],
    ['300자 넘는 제목', { space: 's', title: 'x'.repeat(301), body: 'b' }],
    ['parentId가 uuid가 아님', { space: 's', title: 't', body: 'b', parentId: '이름' }],
    ['모르는 format', { space: 's', title: 't', body: 'b', format: 'html' }],
  ])('거절: %s', (_name, input) => {
    expect(v1CreatePageDto.safeParse(input).success).toBe(false);
  });

  it('**HTML 본문은 거절한다** — 까닭이 본문 칸에 붙는다', () => {
    const r = v1CreatePageDto.safeParse({ space: 's', title: 't', body: '<script>x</script>' });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].path.join('.')).toBe('body');
    expect(!r.success && r.error.issues[0].message).toMatch(/HTML/);
  });

  it('본문이 너무 길면 거절한다', () => {
    expect(v1CreatePageDto.safeParse({ space: 's', title: 't', body: '가'.repeat(MARKDOWN_LIMITS.maxInputChars + 1) }).success).toBe(false);
  });

  it('모르는 칸은 거절한다 — 에이전트의 오타가 조용히 사라지지 않게', () => {
    const r = v1CreatePageDto.safeParse({ space: 's', title: 't', body: 'b', parent: UUID });
    expect(r.success).toBe(false);
  });
});

describe('v1UpdatePageDto — 고칠 것만 (FR-2223)', () => {
  it('본문만, 제목만으로 통과한다', () => {
    expect(v1UpdatePageDto.parse({ body: '새 글' }).doc?.type).toBe('doc');
    expect(v1UpdatePageDto.parse({ title: '새 제목' })).toMatchObject({ title: '새 제목', doc: undefined, baseVersionNo: undefined });
  });

  it('기준 버전은 고르면 쓴다 — 없으면 서버가 지금 버전을 쓴다', () => {
    expect(v1UpdatePageDto.parse({ body: 'x', baseVersionNo: 3 }).baseVersionNo).toBe(3);
  });

  it('아무것도 고치지 않으면 거절한다', () => {
    expect(v1UpdatePageDto.safeParse({}).success).toBe(false);
    expect(v1UpdatePageDto.safeParse({ baseVersionNo: 3 }).success).toBe(false);
  });

  it('기준 버전은 양의 정수', () => {
    expect(v1UpdatePageDto.safeParse({ body: 'x', baseVersionNo: 0 }).success).toBe(false);
    expect(v1UpdatePageDto.safeParse({ body: 'x', baseVersionNo: 1.5 }).success).toBe(false);
  });
});

describe('v1MovePageDto — 위치를 안 주면 맨 끝', () => {
  it('부모만 주면 위치는 맨 끝(형제 수보다 큰 값)이다', () => {
    const r = v1MovePageDto.parse({ parentId: UUID });
    expect(r.parentId).toBe(UUID);
    expect(r.position).toBe(V1_DEFAULTS.moveToEnd);
  });

  it('맨 위로 옮길 때는 parentId: null이고 위치는 고르면 쓴다', () => {
    expect(v1MovePageDto.parse({ parentId: null, position: 0 })).toEqual({ parentId: null, position: 0 });
  });

  it('parentId는 있어야 한다(null이라도) — 모르는 채로 옮기지 않는다', () => {
    expect(v1MovePageDto.safeParse({ position: 1 }).success).toBe(false);
    expect(v1MovePageDto.safeParse({ parentId: UUID, position: -1 }).success).toBe(false);
    expect(v1MovePageDto.safeParse({ parentId: UUID, extra: 1 }).success).toBe(false);
  });
});

describe('v1PageQuery — 읽기 형식 기본값', () => {
  it('없으면 markdown', () => {
    expect(v1PageQuery.parse({}).format).toBe('markdown');
    expect(v1PageQuery.parse({ format: 'json' }).format).toBe('json');
    expect(v1PageQuery.parse({ format: 'text' }).format).toBe('text');
  });

  it('모르는 형식은 거절한다', () => {
    expect(v1PageQuery.safeParse({ format: 'html' }).success).toBe(false);
  });
});

describe('matchSpaces — id나 이름으로 스페이스 고르기 (설계서 3.5절)', () => {
  const list = [
    { id: UUID, name: '장애 보고' },
    { id: '5a6b7c8d-1111-4222-8333-444455556666', name: '인사 규정' },
    { id: '9a9a9a9a-1111-4222-8333-444455556666', name: '인사 규정' },
    { id: '7d7d7d7d-1111-4222-8333-444455556666', name: 'Ops Notes' },
  ];

  it('id가 맞으면 그 스페이스 하나', () => {
    expect(matchSpaces(UUID, list)).toEqual([list[0]]);
    expect(matchSpaces(UUID.toUpperCase(), list)).toEqual([list[0]]);
  });

  it('이름이 정확히 맞으면 그것', () => {
    expect(matchSpaces('장애 보고', list)).toEqual([list[0]]);
  });

  it('이름이 겹치면 모두 돌려준다 — 임의로 고르지 않는다', () => {
    expect(matchSpaces('인사 규정', list)).toHaveLength(2);
  });

  it('정확히 맞는 것이 없을 때만 대소문자·빈칸을 무시한다', () => {
    expect(matchSpaces('ops notes', list)).toEqual([list[3]]);
    expect(matchSpaces(' 장애  보고 ', list)).toEqual([list[0]]);
  });

  it('정확히 맞는 것이 있으면 느슨한 후보는 보지 않는다', () => {
    const l = [
      { id: 'a', name: 'ops' },
      { id: 'b', name: 'OPS' },
    ];
    expect(matchSpaces('ops', l).map((s) => s.id)).toEqual(['a']);
  });

  it('없으면 빈 목록', () => {
    expect(matchSpaces('없는 곳', list)).toEqual([]);
    expect(matchSpaces('', list)).toEqual([]);
  });
});

describe('v1ErrorBody — 한 모양 (FR-2211)', () => {
  const rid = 'req-1';

  it('코드가 있는 오류(가드)는 그 코드와 문장을 그대로', () => {
    expect(v1ErrorBody(401, { code: 'TOKEN_EXPIRED', message: '토큰을 쓸 수 없다' }, rid)).toEqual({
      error: { code: 'TOKEN_EXPIRED', message: '토큰을 쓸 수 없다', requestId: rid },
    });
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [429, 'RATE_LIMITED'],
    [503, 'UNAVAILABLE'],
    [500, 'INTERNAL'],
    [502, 'INTERNAL'],
  ])('코드가 없으면 상태 %i는 %s', (status, code) => {
    expect(v1ErrorBody(status, { message: '문장' }, rid).error).toMatchObject({ code, message: '문장', requestId: rid });
  });

  it('문장만 있는 오류(문자열)도 받는다', () => {
    expect(v1ErrorBody(404, '페이지를 찾을 수 없다', rid).error.message).toBe('페이지를 찾을 수 없다');
  });

  it('문장이 없으면 상태의 기본 문장', () => {
    expect(v1ErrorBody(404, undefined, rid).error.message.length).toBeGreaterThan(0);
  });

  it('입력 검증 실패는 칸과 까닭을 한 문장에 싣는다 — 값은 싣지 않는다', () => {
    const e = v1ErrorBody(400, { message: '요청 검증 실패', issues: [{ path: 'title', message: '비어 있을 수 없다' }, { path: 'body', message: '2행: 원시 HTML은 받지 않는다' }] }, rid).error;
    expect(e.code).toBe('INVALID_REQUEST');
    expect(e.message).toContain('title');
    expect(e.message).toContain('원시 HTML');
  });

  it('검증 실패가 많아도 문장이 불어나지 않는다', () => {
    const issues = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}`, message: '틀림' }));
    expect(v1ErrorBody(400, { message: '요청 검증 실패', issues }, rid).error.message.length).toBeLessThan(600);
  });

  it('기준 버전이 어긋난 409는 VERSION_CONFLICT와 지금 버전을 말한다', () => {
    const e = v1ErrorBody(409, { message: '다른 사용자가 먼저 저장했다', currentVersionNo: 7, baseVersionNo: 5 }, rid).error;
    expect(e.code).toBe('VERSION_CONFLICT');
    expect(e.details).toEqual({ currentVersionNo: 7 });
  });

  it('`details`가 있으면 그대로 싣는다 (이름이 겹친 스페이스의 후보)', () => {
    const e = v1ErrorBody(409, { code: 'SPACE_AMBIGUOUS', message: '이름이 겹친다', details: { candidates: [{ id: UUID, name: 'x' }] } }, rid).error;
    expect(e.details).toEqual({ candidates: [{ id: UUID, name: 'x' }] });
  });

  it('요청 번호가 없으면 null', () => {
    expect(v1ErrorBody(500, undefined, null).error.requestId).toBeNull();
  });
});

describe('v1CreateSpaceDto — 이름만으로 팀 스페이스 (FR-2223)', () => {
  it('이름만 주면 통과하고 설명은 빈 글, 분류는 없음이다', () => {
    expect(v1CreateSpaceDto.parse({ name: '  장애 보고 ' })).toEqual({ name: '장애 보고', description: '', category: null });
  });

  it('분류는 **이름**으로 고른다 — id를 외우지 않는다', () => {
    expect(v1CreateSpaceDto.parse({ name: 's', category: '운영' }).category).toBe('운영');
    expect(v1CreateSpaceDto.parse({ name: 's', category: null }).category).toBeNull();
  });

  it('종류(kind)는 받지 않는다 — 에이전트가 만드는 것은 팀 스페이스뿐이다(개인 스페이스는 계정과 함께 생긴다)', () => {
    expect(V1_DEFAULTS.spaceKind).toBe('team');
    expect(v1CreateSpaceDto.safeParse({ name: 's', kind: 'personal' }).success).toBe(false);
  });

  it.each([
    ['이름 없음', {}],
    ['빈 이름', { name: '  ' }],
    ['200자 넘는 이름', { name: 'x'.repeat(201) }],
    ['2000자 넘는 설명', { name: 's', description: 'x'.repeat(2001) }],
    ['빈 분류 이름', { name: 's', category: '  ' }],
  ])('거절: %s', (_n, input) => {
    expect(v1CreateSpaceDto.safeParse(input).success).toBe(false);
  });
});

describe('v1UpdateSpaceDto', () => {
  it('고칠 것만 — 분류는 null이면 지운다(없으면 그대로)', () => {
    expect(v1UpdateSpaceDto.parse({ name: '새 이름' })).toEqual({ name: '새 이름' });
    expect(v1UpdateSpaceDto.parse({ category: null })).toEqual({ category: null });
    expect(v1UpdateSpaceDto.parse({ description: '', category: '운영' })).toEqual({ description: '', category: '운영' });
  });

  it('아무것도 고치지 않으면 거절한다', () => {
    expect(v1UpdateSpaceDto.safeParse({}).success).toBe(false);
  });
});

describe('v1SpaceStatusDto', () => {
  it('중지와 다시 쓰기', () => {
    expect(v1SpaceStatusDto.parse({ status: 'suspended' })).toEqual({ status: 'suspended' });
    expect(v1SpaceStatusDto.parse({ status: 'active' })).toEqual({ status: 'active' });
  });

  it('넘겨받기(takeover)는 중지에만 붙는다', () => {
    expect(v1SpaceStatusDto.parse({ status: 'suspended', takeover: true })).toEqual({ status: 'suspended', takeover: true });
    expect(v1SpaceStatusDto.parse({ status: 'suspended', takeover: false })).toEqual({ status: 'suspended' });
    expect(v1SpaceStatusDto.safeParse({ status: 'active', takeover: true }).success).toBe(false);
  });

  it('모르는 상태는 거절', () => {
    expect(v1SpaceStatusDto.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});

describe('Crew 입력 — 사용자 이름으로, 기본은 editor', () => {
  it('넣기: 이름만 주면 editor', () => {
    expect(V1_DEFAULTS.memberRole).toBe('editor');
    expect(v1AddMemberDto.parse({ username: 'bob' })).toEqual({ username: 'bob', role: 'editor' });
    expect(v1AddMemberDto.parse({ username: 'bob', role: 'viewer' }).role).toBe('viewer');
  });

  it('owner 자리는 줄 수 없다', () => {
    expect(v1AddMemberDto.safeParse({ username: 'bob', role: 'owner' }).success).toBe(false);
    expect(v1MemberRoleDto.safeParse({ role: 'owner' }).success).toBe(false);
  });

  it('자리 바꾸기는 역할이 필수다', () => {
    expect(v1MemberRoleDto.parse({ role: 'viewer' })).toEqual({ role: 'viewer' });
    expect(v1MemberRoleDto.safeParse({}).success).toBe(false);
  });
});

describe('분류 입력', () => {
  it('이름만', () => {
    expect(v1CategoryDto.parse({ name: ' 운영 ' })).toEqual({ name: '운영' });
    expect(v1CategoryDto.safeParse({ name: '' }).success).toBe(false);
    expect(v1CategoryDto.safeParse({ name: 'x'.repeat(51) }).success).toBe(false);
  });
});

describe('v1SpaceListQuery', () => {
  it('찾기 `q`와 `limit`는 모두 선택이다', () => {
    expect(v1SpaceListQuery.parse({})).toEqual({});
    expect(v1SpaceListQuery.parse({ q: ' 장애 ', limit: '10' })).toEqual({ q: '장애', limit: 10 });
  });

  it('limit 범위를 지킨다', () => {
    expect(v1SpaceListQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(v1SpaceListQuery.safeParse({ limit: String(V1_DEFAULTS.listLimitMax + 1) }).success).toBe(false);
  });
});

describe('matchMember — 사용자 이름이나 id로 Crew 고르기', () => {
  const members = [
    { userId: UUID, username: 'alice', displayName: '앨리스' },
    { userId: '5a6b7c8d-1111-4222-8333-444455556666', username: 'bob', displayName: '밥' },
  ];

  it('id로도 사용자 이름으로도, 대소문자는 무시한다', () => {
    expect(matchMember(UUID, members)).toBe(members[0]);
    expect(matchMember('bob', members)).toBe(members[1]);
    expect(matchMember(' BOB ', members)).toBe(members[1]);
  });

  it('없으면 null', () => {
    expect(matchMember('carol', members)).toBeNull();
    expect(matchMember('', members)).toBeNull();
  });
});

describe('응답 줄이기 — 에이전트가 쓸 것만', () => {
  const view = {
    id: UUID,
    key: 'k',
    name: '장애 보고',
    description: '설명',
    kind: 'team',
    status: 'active',
    suspendedByOwner: false,
    categoryId: 'c1',
    categoryName: '운영',
    createdBy: 'u1',
    createdByUsername: 'alice',
    memberCount: 3,
    myRole: 'owner',
    access: { canRead: true, canWrite: true, canManageMembers: true, canEditInfo: true, canChangeStatus: true, canDelete: true, isOwner: true, crewFrozen: false },
    createdAt: 'a',
    updatedAt: 'b',
  } as unknown as SpaceView;

  it('스페이스: 이름·분류 이름·내 역할과 할 수 있는 일', () => {
    expect(toV1Space(view)).toEqual({
      id: UUID,
      name: '장애 보고',
      description: '설명',
      kind: 'team',
      status: 'active',
      category: '운영',
      categoryId: 'c1',
      memberCount: 3,
      myRole: 'owner',
      canWrite: true,
      canManageMembers: true,
    });
  });

  it('Crew: 아이디·표시 이름·역할', () => {
    expect(toV1Member({ userId: UUID, username: 'bob', displayName: '밥', role: 'editor', createdAt: 'x' })).toEqual({ userId: UUID, username: 'bob', displayName: '밥', role: 'editor' });
  });

  it('분류: 이름과 바꾸고 지울 수 있는지', () => {
    expect(
      toV1Category({ id: 'c1', name: '운영', createdBy: 'u1', createdAt: 'x', access: { canRename: true, canDelete: false }, usage: null }),
    ).toEqual({ id: 'c1', name: '운영', canRename: true, canDelete: false });
  });
});
