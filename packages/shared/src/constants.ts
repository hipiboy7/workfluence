/**
 * 설계상 고정값 (CLAUDE.md 5절). 바꾸면 데이터·마이그레이션을 다시 만들어야 하는 것만 여기에 둔다.
 * 환경별 값은 .env(env.ts), 운영 조절값은 Phase 4부터 DB settings.
 */

/** 시스템 역할. root ⊃ admin ⊃ member (docs/prompts/prototype-v2.md 2절 12번) */
export const ROLES = ['root', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** 사용자 상태. '잠김'은 저장하지 않고 locked_until로 파생한다 */
export const USER_STATUSES = ['pending', 'active'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SPACE_KINDS = ['personal', 'team'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

export const SPACE_STATUSES = ['active', 'suspended'] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];

/** Crew 역할. owner는 생성자에게 자동 부여, 나머지는 owner·admin이 지정 */
export const SPACE_MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type SpaceMemberRole = (typeof SPACE_MEMBER_ROLES)[number];
export const ASSIGNABLE_MEMBER_ROLES = ['editor', 'viewer'] as const;

/**
 * 문서(ProseMirror JSON) 스키마 버전. 노드·마크 허용 목록이 바뀌면 올린다.
 *
 * - 1: Phase 2~8.
 * - 2: Phase 9 (P9_설계서_Gate D.7) — 링크 `title`·표 칸 `align`을 더하고, 편집기가 만들 수 없던 `textAlign`을 뺐다.
 *   자식 규칙·노드별 마크 규칙이 생겼다. 1로 찍힌 문서는 그 규칙 이전에 저장된 것이다.
 */
export const DOCUMENT_SCHEMA_VERSION = 2;

/** 감사 이벤트 종류 (CLAUDE.md 6절 감사로그 대상) */
export const AUDIT_ACTIONS = [
  'auth.login.success',
  'auth.login.failure',
  'auth.logout',
  'auth.password.change',
  'auth.id.recover',
  'auth.password.recover',
  'user.signup',
  'user.create',
  'user.approve',
  'user.unlock',
  'user.password.reset',
  'user.sessions.terminate',
  'user.role.change',
  'category.create',
  'space.create',
  'space.update',
  'space.status.change',
  'space.delete',
  'space.member.add',
  'space.member.role.change',
  'space.member.remove',
  'page.create',
  'page.update',
  'page.move',
  'page.delete',
  'page.restore',
  'page.version.restore',
  'attachment.upload',
  'attachment.download',
  'attachment.delete',
  'comment.create',
  'comment.update',
  'comment.delete',
  'page.restore.trash',
  'space.restore',
  'trash.purge',
  'audit.purge',
  'backup.create',
  'backup.restore',
  'label.attach',
  'label.detach',
  'category.update',
  'category.delete',
  'settings.update',
  // Phase 6 (P6_설계서_Collab D.2절)
  'page.export',
  'page.collab.save',
  'page.collab.flush',
  'template.create',
  'template.update',
  'template.delete',
  'mail.send',
  'mail.fail',
  // Phase 9 (P9_설계서_Gate D.6) — 실시간 편집의 관문이 받지 않은 변경. 누가·어느 페이지·어느 규칙
  'page.collab.reject',
  // Phase 10 (P10_설계서_Llm E절) — 사내 LLM. 질문은 **내용 없이** 누가·어느 LLM·얼마만큼·결과만 (FR-1118)
  'llm.provider.create',
  'llm.provider.delete',
  'llm.ask',
  'llm.conversation.purge',
] as const;

/**
 * 실시간 편집에서 **관문이 변경을 받지 않아** 연결을 닫을 때의 닫기 코드 (P9_설계서_Gate D.6, FR-1005).
 * 4000~4999는 응용이 쓰는 자리다. 화면은 이 코드를 보고 "서버가 이 편집을 받지 않았다"를 말한다 — 그냥
 * 끊긴 것과 달리 **다시 붙어도 같은 편집은 다시 거절된다**는 뜻이라 따로 말한다.
 */
export const COLLAB_CLOSE_REFUSED = 4400;

/**
 * 거절·검증 실패의 **까닭**에 적는 이름·키의 최대 길이 (P9 코드 리뷰 4 · 두 번째 코드 리뷰 8). 까닭은 경고 로그와 감사로그(지울 수 없다)로 가고, 이름·키는
 * 조작한 클라이언트가 정한다 — 넘으면 자른다(`cutName`)
 */
export const MAX_NAME_IN_REASON = 40;

/**
 * 실시간 편집 프레임의 **앞 한 바이트** — 무엇이 실렸나 (P6_설계서_Collab C.2절 · P9_설계서_Gate D.9, FR-1011).
 * 서버(`collab.gateway.ts`)와 화면(`collabLink.ts`)이 이것 하나를 쓴다 — 따로 적으면 한쪽만 바뀐다.
 *
 * - `update` 문서 변경(Yjs), `awareness` 사람 표시(y-protocols) — 양쪽이 보낸다
 * - `status` **서버만 보낸다.** 이 방의 자동 저장이 멈췄는지(`CollabStatus`). 화면이 보낸 것은 서버가 버린다
 */
export const COLLAB_MSG = { update: 0, awareness: 1, status: 2 } as const;

/** `COLLAB_MSG.status`에 실리는 것(UTF-8 JSON). `saveBlocked`는 자동 저장이 멈춘 까닭이고, 풀리면 `null`이다 */
export type CollabStatus = { saveBlocked: string | null };
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 페이지 트리 최대 깊이. 무한 중첩은 이동·경로 계산 비용을 키운다. */
export const PAGE_TREE_MAX_DEPTH = 10;

/** 상태 변경 요청에 요구하는 CSRF 헤더 (CLAUDE.md 7절). 값이 아니라 헤더의 존재가 방어다. */
export const CSRF_HEADER = 'x-workfluence-request';
export const CSRF_HEADER_VALUE = '1';

/** 로컬 계정 비밀번호 정책 (사용자 결정 2026-09-15: 8자·2종. 잠금 5회/15분 유지) */
export const PASSWORD_POLICY = {
  minLength: 8,
  minCharClasses: 2,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
} as const;

/** 임시(초기화) 비밀번호 길이. 생성 규칙은 security.ts */
export const TEMP_PASSWORD_LENGTH = 12;


/**
 * 첨부로 받을 수 있는 확장자 (P4_설계서_Admin FR-521).
 *
 * **판정 규칙(`attachments/domain/upload.ts`·`signature.ts`)이 있는 것만 여기 있다.**
 * 관리자가 이 목록 밖의 확장자를 켤 수는 없다 — 규칙 없는 확장자를 허용하면 내용 검사를
 * 지나치게 되고, 그것이 곧 "이름만 바꾼 파일"이 들어오는 길이다.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv', 'md', 'zip', 'docx', 'xlsx', 'pptx', 'hwp',
] as const;

/**
 * 관리·목록 화면이 한 번에 받아 오는 최대 건수 (P4_설계서_Admin FR-537).
 *
 * 300명 규모에서 이 목록들이 수천을 넘지 않으므로 페이지네이션 대신 **상한 + 검색**으로
 * 간다. 넘기 시작하면 그때 만든다 — 지금 만들면 쓰이지 않는 코드가 된다.
 */
export const LIST_PAGE_LIMIT = 200;

/** settings 테이블 키 */
export const SETTINGS_KEYS = {
  contactInfo: 'contact_info',
  /** 운영 정책값 한 덩어리 (P4_설계서_Admin FR-520). 키마다 행을 두지 않는 이유는 한 번에 읽고 한 번에 캐시하기 위해서다 */
  policy: 'policy',
} as const;

/** 공개 엔드포인트 요청 제한 (IP 기준). 계정 열거·무차별 대입 완화 */
export const RATE_LIMITS = {
  signup: { max: 5, windowSec: 600 },
  findId: { max: 5, windowSec: 60 },
  recoverPassword: { max: 3, windowSec: 600 },
  login: { max: 20, windowSec: 60 },
} as const;

/**
 * DB 연결 풀 (P5_설계서_Release, T-026).
 *
 * **왜 상수로 두는가.** 세 값이 서로를 전제한다. `max`보다 많은 요청이 동시에 트랜잭션을
 * 열면 뒤에 온 요청은 기다리는데, 기다리는 시간에 상한이 없으면 **영구히 멈춘다.** 실제로
 * 그렇게 멈췄다. 그래서 기다림에 상한을 두고(`connectionTimeoutMillis`), 트랜잭션을 열어 둔
 * 채 잊어버린 연결은 DB가 끊게 한다(`idleInTransactionTimeoutMillis`).
 *
 * 세 값은 "느려진다"와 "조용히 멈춘다" 사이의 선택이다. **느려지는 쪽을 고른다** —
 * 500이 나면 로그와 화면에 보이지만, 멈추면 아무 데도 안 보인다.
 */
export const DB_POOL = {
  /** 동시에 열어 두는 연결 수. 300명·동시 수십 세션 기준 */
  max: 10,
  /** 연결을 못 얻으면 이만큼 기다렸다 **실패한다**. 무한 대기 금지 */
  connectionTimeoutMillis: 10_000,
  /** 트랜잭션을 열어 둔 채 놀고 있는 연결을 DB가 끊는다. 새는 곳이 있어도 스스로 낫는다 */
  idleInTransactionTimeoutMillis: 30_000,
} as const;

/**
 * 사내 LLM 질문의 설계 고정값 (P10_설계서_Llm I절, FR-1115·1116·1129).
 *
 * 운영이 조절하는 보존 기간·대화 수·고정 수는 여기가 아니라 정책값이다(`policy.ts`). 여기 있는 것은 **한 사람의 입력이
 * 서버 메모리와 저장 공간을 채우지 않게** 하는 선과, 서버 안의 주기다.
 */
export const LLM_LIMITS = {
  /** 질문 하나. 위키 페이지 하나를 통째로 붙여 넣을 수 있는 크기다 — 모델의 문맥보다 길면 LLM 서버가 거절한다(FR-1120) */
  questionMaxChars: 100_000,
  /** 답 하나. 넘으면 LLM 요청을 끊고 거기까지를 "끊김"으로 남긴다. 생각 과정도 같은 선에서 끊는다 */
  answerMaxChars: 200_000,
  /** 대화 하나의 메시지 수(질문 + 답). 문맥이 큰 모델에서 대화 하나가 끝없이 자라지 않게 (D.3) */
  messagesPerConversation: 200,
  /** 지시문 하나의 길이와 사람마다의 개수 */
  promptMaxChars: 20_000,
  promptsPerUser: 50,
  /** LLM·지시문 이름 */
  nameMaxChars: 80,
  /** 대화 제목 — 첫 질문의 첫 줄에서 이만큼 */
  titleChars: 40,
  /** 등록하는 모델 이름·API 키의 길이 */
  modelMaxChars: 200,
  apiKeyMaxChars: 4_096,
  /** LLM 주소의 길이. 사내 호스트 주소가 이보다 길 까닭이 없다 */
  baseUrlMaxChars: 500,
  /**
   * LLM 흐름(SSE)의 **한 줄·한 이벤트**의 상한 (검토 반영 — 보안 검토 1). 줄바꿈 없는 줄이 끝없이 오면 답 상한과 무관하게 앱 메모리가
   * 는다. 정상 흐름의 한 이벤트는 수백 자다
   */
  sseLineMaxChars: 1_000_000,
  /** 답 맨 앞에서 `<think>`를 기다리며 붙드는 빈칸의 상한. 넘으면 답으로 넘겨 답 상한이 걸리게 한다 */
  thinkLeadMaxChars: 1_000,
  /** 화면에 말하는 LLM 쪽 까닭의 길이 (FR-1120) */
  errorMessageMaxChars: 300,
  /** 오류 본문은 이만큼만 읽는다 — 까닭 한 줄이면 된다 */
  errorBodyMaxBytes: 64 * 1024,
  /** 모델 목록(`/models`) 응답의 상한 */
  modelsBodyMaxBytes: 1024 * 1024,
} as const;

/** 문서 → 마크다운 변환의 상한 (P10 D.7). 조작한 문서의 `colspan`·`rowspan` 10만이 배열 10만 개가 되지 않게 (보류 27과 같은 걱정) */
export const MARKDOWN_LIMITS = {
  maxSpan: 100,
} as const;

/** 주기·시간 (P10_설계서_Llm D.1·D.5·G절, FR-1105·1115·1136) */
export const LLM_TIMINGS = {
  /** 이만큼 아무것도 안 보냈으면 살아 있음 줄을 보낸다 — nginx `proxy_read_timeout`(300초)보다 한참 짧게 */
  heartbeatMs: 15_000,
  /** 만료된 대화를 지우는 주기 */
  sweepMs: 3_600_000,
  /** 연결 확인(`/models`)의 시간 상한 */
  checkTimeoutMs: 10_000,
  /** 화면이 흘러오는 글자를 모아 그리는 간격 — 조각마다 그리면 답이 길어질수록 느려진다(그릴 때마다 답 전체를 다시 그린다) */
  renderBatchMs: 50,
} as const;
