import { POLICY_DEFAULTS, POLICY_RANGES, type Policy } from './policy';

/**
 * 공개 API 명세의 입력 칸 설명 (docs/spinoff/public-api 설계서 3.3-1절). **에이전트가 이름만 보고 짐작하지 않게** 칸마다 뜻·단위·범위를 적는다.
 * 열쇠는 `칸 이름`이고, 같은 이름이 동작마다 뜻이 다르면 `동작id.칸 이름`이 먼저 쓰인다. 코드가 만드는 설명(`.describe`)이 있으면 그것이 이긴다.
 * 빠진 칸이 있으면 `v1-spec.spec.ts`가 실패한다.
 */

const policy = (text: string, key: keyof Policy): string => {
  const r = POLICY_RANGES[key];
  const range = r ? `${r.min}~${r.max}` : '';
  return `${text}${range ? ` (${range}, 기본 ${String(POLICY_DEFAULTS[key])})` : ''}`;
};

export const V1_FIELD_DOCS: Record<string, string> = {
  // ---- 공통 쿼리 ----
  format: '본문 형식 — markdown(기본)·json·text. 쓰기는 markdown·json만',
  limit: '돌려줄 가장 많은 수 — 넘으면 400이고 안 주면 기본값',
  q: '찾을 말 — 이름의 일부(대소문자 무시)',
  offset: '건너뛸 수(앞에서부터) — 다음 쪽을 읽을 때 쓴다',
  status: '이 상태인 것만',
  'users.list.status': '계정 상태로 거른다 — pending(승인 대기)·active·locked·suspended. 안 주면 모두',
  'spaces.setStatus.status': '바꿀 상태 — active(다시 쓰기)·suspended(중지)',

  // ---- 감사 ----
  action: '행위 코드로 거른다(예: page.delete, api_token.create)',
  actorId: '그 일을 한 사용자의 id로 거른다',
  from: '이 시각부터(포함) — ISO 8601. 날짜만 주면 그날 00:00부터',
  to: '이 시각까지(제외) — ISO 8601. 날짜만 주면 그날 00:00까지',
  requestId: '요청 번호로 거른다 — 오류 응답의 `error.requestId`나 로그 한 줄의 값',

  // ---- 페이지·댓글 ----
  body: '본문 — `format`이 markdown이면 마크다운 글, json이면 문서 객체. 원시 HTML·허용 밖 링크는 400',
  'pages.update.body': '새 본문 — `format`이 markdown이면 마크다운 글, json이면 문서 객체. 안 주면 본문은 그대로',
  'templates.update.body': '새 본문 — 문서 객체(JSON). 안 주면 그대로',
  'comments.create.body': '댓글 본문 — `format`이 markdown이면 마크다운 글. `@사용자이름`은 멘션이 되어 알림이 간다',
  'comments.update.body': '새 댓글 본문 — `format`이 markdown이면 마크다운 글',
  parentId: '부모의 id',
  'pages.move.parentId': '새 부모 페이지의 id — null이면 스페이스의 맨 위로 옮긴다',
  'comments.create.parentId': '답글이면 부모 댓글의 id — 없으면 새 댓글',
  position: '형제 사이의 자리(0이 맨 앞) — 안 주면 형제의 맨 끝',

  // ---- 첨부 ----
  filename: '파일 이름 — 경로 구분자(/, \\)를 쓸 수 없다. 허용 확장자만 올라간다(`GET /settings/policy`의 allowedExtensions)',
  content: '파일 내용 — `encoding`이 utf8이면 글 그대로, base64면 base64 글',
  encoding: '`content`의 인코딩 — utf8(글 파일, 기본)·base64(이진 파일)',

  // ---- 이름·설명 ----
  name: '이름',
  'categories.create.name': '분류 이름',
  'categories.rename.name': '새 분류 이름',
  'labels.attach.name': '라벨 이름 — 없으면 만든다. 소문자로 저장된다',
  'spaces.create.name': '스페이스 이름 — 같은 이름이 둘이어도 되지만 이름으로 고를 때는 409(SPACE_AMBIGUOUS)가 난다',
  'spaces.update.name': '새 스페이스 이름',
  'templates.create.name': '템플릿 이름',
  'templates.update.name': '새 템플릿 이름',
  description: '설명',
  'spaces.create.description': '스페이스 설명(선택)',
  'spaces.update.description': '새 설명 — null이면 지운다',
  'templates.create.description': '템플릿 설명(선택)',
  'templates.update.description': '새 설명 — null이면 지운다',
  category: '분류의 이름 — 없는 분류면 만든다',
  'spaces.create.category': '스페이스를 넣을 분류의 이름(선택) — 없는 분류면 만든다',
  'spaces.update.category': '새 분류의 이름 — null이면 분류를 없앤다',

  // ---- 스페이스·사용자 ----
  role: '역할',
  'spaces.addMember.role': 'Crew 역할 — editor(고칠 수 있다)·viewer(읽기만). 안 주면 editor',
  'spaces.setMemberRole.role': '바꿀 Crew 역할 — editor·viewer. owner는 줄 수 없다',
  'users.create.role': '계정 역할 — root·admin·member. root는 root만 줄 수 있다',
  'users.setRole.role': '바꿀 역할 — root·admin·member. root는 root만 줄 수 있다',
  username: '사용자 아이디(로그인 이름)',
  'spaces.addMember.username': 'Crew에 넣을 사용자의 아이디',
  'users.create.username': '새 계정의 아이디(로그인 이름)',
  displayName: '화면에 보일 이름',
  email: '이메일 주소',
  password: '처음 비밀번호 — 비밀번호 규칙(`GET /settings/policy`)을 지켜야 한다. 응답에는 나오지 않는다',
  takeover: '관리자가 중지를 넘겨받을 때만 true — 화면이 본 "주인이 건 중지"를 그대로 관리자가 건 중지로 바꾼다. 그 사이 주인이 풀었으면 409',
  grants: '그 사람에게 줄 위임의 전체 목록 — 목록에 없는 위임은 거둔다. 받는 역할이 아니면 효력이 없다',
  expected: '화면이 본 지금의 위임 목록 — 서버의 목록과 다르면 409(그 사이 누가 바꿨다). 안 주면 확인 없이 바꾼다',

  // ---- 운영 정책 (`PATCH /settings/policy`) ----
  allowedExtensions: '올릴 수 있는 파일 확장자의 전체 목록(점 없이, 소문자) — 목록에 없는 확장자의 첨부는 거절한다',
  uploadMaxMb: policy('첨부 한 개의 최대 크기(MB)', 'uploadMaxMb'),
  sessionIdleMinutes: policy('아무것도 안 하면 로그인이 끝나는 시간(분)', 'sessionIdleMinutes'),
  sessionAbsoluteHours: policy('로그인한 지 이만큼 지나면 무조건 끝나는 시간(시간)', 'sessionAbsoluteHours'),
  passwordMinLength: policy('비밀번호의 최소 글자 수', 'passwordMinLength'),
  passwordMinCharClasses: policy('비밀번호에 들어야 하는 글자 종류의 수(영문 대·소문자·숫자·특수)', 'passwordMinCharClasses'),
  lockoutThreshold: policy('로그인에 이만큼 틀리면 계정을 잠근다(횟수)', 'lockoutThreshold'),
  lockoutMinutes: policy('잠그는 시간(분)', 'lockoutMinutes'),
  trashRetentionDays: policy('휴지통에 두는 기간(일) — 지나면 물리 삭제', 'trashRetentionDays'),
  auditRetentionDays: policy('감사로그를 두는 기간(일) — 지나면 정리', 'auditRetentionDays'),
  llmRetentionDays: policy('고정하지 않은 사내 LLM 대화를 마지막 사용 뒤 두는 기간(일)', 'llmRetentionDays'),
  llmConversationMax: policy('사람마다 남기는 사내 LLM 대화의 최대 수', 'llmConversationMax'),
  llmPinnedMax: policy('고정할 수 있는 대화의 최대 수(0이면 고정을 안 쓴다) — 대화 최대 수보다 작아야 한다', 'llmPinnedMax'),
  auditLevel: policy('감사 기록 단계 — 3 전체·2 줄임(실시간 자동 저장을 뺀다)·1 최소. 시스템 관리자(root)만 바꾼다', 'auditLevel'),
  passwordResetMail: policy('메일 재설정 켜기(1)·끄기(0)', 'passwordResetMail'),
};

/** 정책 칸은 코드가 정수의 안전 범위(±9007199254740991)를 적으므로, 진짜 허용 범위로 바꿔 쓴다 */
export function policyRangeOf(field: string): { min: number; max: number } | undefined {
  return field in POLICY_DEFAULTS ? POLICY_RANGES[field] : undefined;
}

/**
 * 성공 응답의 칸 설명 — 이름으로 찾는다(같은 이름은 어느 응답에서나 같은 뜻이다. 뜻이 갈리는 이름은 둘을 함께 적는다).
 * 코드가 붙인 설명이 있으면 그것이 이긴다. 빠진 칸이 있으면 `v1-spec.spec.ts`가 실패한다
 */
export const V1_RESPONSE_DOCS: Record<string, string> = {
  // 공통
  id: '그 대상의 id — 다른 호출의 경로에 넣는다',
  ok: '성공이면 늘 true',
  count: '바뀐 것의 수',
  items: '결과 목록 — 없으면 빈 배열',
  name: '이름',
  title: '제목',
  description: '설명(없으면 null)',
  status: '상태 — 스페이스는 active·suspended, 사용자는 pending·active·locked·suspended',
  kind: '종류 — 스페이스는 personal(개인)·team(팀), 알림은 알림의 종류',
  type: '문서 노드의 종류(doc·paragraph·heading 등)',
  format: '본문의 형식 — markdown·json·text',
  key: '스페이스를 가리키는 짧은 키',
  createdAt: '만든 때(ISO 8601)',
  updatedAt: '마지막으로 바뀐 때(ISO 8601)',
  deletedAt: '지운 때(ISO 8601)',
  readAt: '읽음으로 바꾼 때(ISO 8601) — 안 읽었으면 null',
  size: '크기(바이트)',
  mime: '파일의 MIME 형식',
  filename: '파일 이름',
  snippet: '검색어 둘레의 본문 조각',
  // 사람
  username: '사용자 아이디(로그인 이름)',
  displayName: '화면에 보이는 이름',
  email: '이메일 주소(없으면 null)',
  role: '역할 — root·admin·member (Crew는 owner·editor·viewer)',
  grants: '받은 위임의 목록(없으면 빈 배열)',
  mustChangePassword: '다음 로그인에서 비밀번호를 바꿔야 하면 true',
  author: '쓴 사람의 이름',
  createdBy: '만든 사람의 id',
  createdByName: '만든 사람의 이름',
  uploadedByName: '올린 사람의 이름',
  deletedByName: '지운 사람의 이름',
  userId: '사용자의 id',
  actorId: '그 일을 한 사용자의 id — 시스템이 했으면 null',
  actorName: '그 일을 한 사람의 이름',
  actorUsername: '그 일을 한 사람의 아이디',
  // 스페이스·페이지
  spaceId: '스페이스의 id',
  spaceName: '스페이스의 이름',
  space: '스페이스 — id와 이름',
  pageId: '페이지의 id',
  pageTitle: '페이지의 제목',
  commentId: '댓글의 id',
  parentId: '부모의 id — 맨 위면 null',
  position: '형제 사이의 자리(0이 맨 앞)',
  category: '분류의 이름(없으면 null)',
  categoryId: '분류의 id(없으면 null)',
  memberCount: 'Crew에 든 사람의 수',
  myRole: '이 스페이스에서 내 역할 — owner·editor·viewer(Crew가 아니면 null)',
  canWrite: '내가 이 스페이스에 쓸 수 있으면 true',
  canManageMembers: '내가 Crew를 바꿀 수 있으면 true(관리자가 중지한 동안은 관리자만)',
  canDelete: '내가 지울 수 있으면 true',
  canRename: '내가 이름을 바꿀 수 있으면 true',
  currentVersionNo: '지금 버전 번호 — 고칠 때 `baseVersionNo`로 보낸다',
  versionNo: '버전 번호(1부터)',
  // 버전 비교
  from: '비교의 앞쪽 버전 — 번호·제목·고친 사람·시각',
  to: '비교의 뒤쪽 버전 — 번호·제목·고친 사람·시각',
  titleChanged: '두 버전의 제목이 다르면 true',
  diff: '본문의 차이 — 바뀐 블록 수와 블록별 차이',
  changed: '본문이 달라졌으면 true',
  added: '새로 생긴 블록의 수',
  removed: '없어진 블록의 수',
  modified: '고쳐진 블록의 수',
  blocks: '블록별 차이의 목록',
  // 감사
  action: '행위 코드(예: page.delete, api_token.create)',
  detail: '그 행위의 자세한 내용(행위마다 다르다) — 토큰으로 한 일이면 `jti`가 그 토큰의 번호',
  ip: '요청한 주소(없으면 null)',
  targetId: '그 일을 당한 대상의 id',
  targetType: '그 일을 당한 대상의 종류',
  // 명세·정책
  openapi: 'OpenAPI 버전',
  allowedExtensions: '올릴 수 있는 파일 확장자의 목록',
  passwordMinCharClasses: '비밀번호에 들어야 하는 글자 종류의 수',
  passwordMinLength: '비밀번호의 최소 글자 수',
  uploadMaxMb: '첨부 한 개의 최대 크기(MB)',
};
