/**
 * 설계상 고정값 (CLAUDE.md 5절). 바꾸면 데이터·마이그레이션을 다시 만들어야 하는 것만 여기에 둔다.
 * 환경별 값은 .env(env.ts), 운영 조절값은 Phase 4부터 DB settings.
 */

/** 시스템 역할. root ⊃ admin ⊃ member (docs/prompts/prototype-v2.md 2절 12번) */
export const ROLES = ['root', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** 사용자 상태. '잠김'은 저장하지 않고 locked_until로 파생한다 */
/** 사용자 상태. **정지**(`suspended`)는 퇴사자 처리다 — 로그인 불가, 내용·소속은 남는다 (P13 C.5, FR-1440) */
export const USER_STATUSES = ['pending', 'active', 'suspended'] as const;
/** 사용자 목록 한 번의 수 (P13 FR-1451). 서버의 기본값과 화면의 "더 보기"가 같은 값을 쓴다 — 300명 규모에서 셋으로 끝까지 닿는다 */
export const USER_LIST_PAGE = 100;
/** 사용자 목록 한 번의 상한 — 화면은 조치 뒤에 보던 만큼(이 값까지) 다시 읽는다. 300명 규모를 한 번에 담는다 (병합 전 코드 리뷰 10) */
export const USER_LIST_MAX = 500;
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
  'user.grants.change',
  // P13 계정 정지 (FR-1444)
  'user.suspend',
  'user.unsuspend',
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
  // 실시간 편집의 제목 바꾸기 — 바꾼 사람을 남긴다. 저장의 작성자는 마지막으로 친 사람이라, 이것이 없으면 제목을 바꾼 사람이 흐려진다 (병합 전 보안 검토 L2)
  'page.collab.title',
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
  // Phase 19 (P19_설계서_Recovery FR-2010) — 비밀번호를 잊었을 때. 메일 재설정 요청(맞았나·보냈나), 링크로 새 비밀번호를 정함(성공·까닭),
  // email이 기억나지 않아 시스템 관리자에게 확인 요청. 관리자에게 초기화 요청은 `auth.password.recover` 그대로
  'auth.password.reset.request',
  'auth.password.reset',
  'auth.email.help',
  // 공개 API (docs/spinoff/public-api 계획서 4.2절) — 토큰 발급·폐기. 값은 싣지 않는다. 폐기의 까닭은 `user`(본인)·`sessions_revoked`(세션을 모두 끊을 때 함께)
  'api_token.create',
  'api_token.revoke',
] as const;

/**
 * 실시간 편집에서 **관문이 변경을 받지 않아** 연결을 닫을 때의 닫기 코드 (P9_설계서_Gate D.6, FR-1005).
 * 4000~4999는 응용이 쓰는 자리다. 화면은 이 코드를 보고 "서버가 이 편집을 받지 않았다"를 말한다 — 그냥
 * 끊긴 것과 달리 **다시 붙어도 같은 편집은 다시 거절된다**는 뜻이라 따로 말한다.
 */
export const COLLAB_CLOSE_REFUSED = 4400;

/**
 * 한 프레임이 상한(`COLLAB_LIMITS.maxFrameBytes`)을 넘어 서버가 닫았다 — WebSocket 표준의 1009("메시지가 너무 크다", `ws`가 보낸다).
 * 화면은 관문의 거절(4400)과 같게 말한다 — 다시 보내도 같은 편집은 다시 닫힌다 (P12 FR-1321)
 */
export const COLLAB_CLOSE_TOO_LARGE = 1009;

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

/**
 * 앱 로그 줄의 **event 코드** (P11_설계서_Ops D.4, FR-1214). 문장(`msg`)을 고쳐도 이 코드는 그대로다 — 장애대응가이드가 이것으로
 * 찾고, `pnpm verify:docs`가 이 목록의 코드가 가이드에 모두 있는지 대조한다. 모양은 `영역.일`(소문자·밑줄)
 */
export const LOG_EVENTS = [
  // 기동
  'app.started',
  'app.migrated',
  // 요청 — 접근 로그 한 줄, 처리되지 않은 예외
  'http.request',
  'http.unhandled',
  'health.db_failed',
  // 사내 인증(OIDC) — 사내 IdP와의 처리가 실패했다(닿지 않음·거절·검증 실패). 바깥 탓이라 warn (FR-1215)
  'auth.oidc_failed',
  'auth.oidc_email_dropped',
  // 비밀번호 찾기 — 초기화 요청을 관리자의 알림으로 만들지 못했다. 우리 쪽 결함이라 error — 요청은 감사 기록에 남았다 (P17 NFR-170)
  'auth.recover_notify_failed',
  // 비밀번호를 잊었을 때 (P19 FR-2012) — 응답 뒤에 도는 일(재설정 값 만들기·메일 보내기, 시스템 관리자에게 알리기)이 우리 쪽 결함으로 실패했다. error —
  // 요청은 감사 기록에 남는다. 메일 API의 거절·연결 실패는 메일 줄(`mail.rejected`·`mail.failed`)이다
  'auth.reset_mail_failed',
  'auth.email_help_failed',
  // 화면 설정(`GET /api/auth/config`)이 운영 설정을 읽지 못했다 — 메일 재설정만 끄고 답한다(실시간 편집·사내 로그인은 .env 값 그대로). 우리 쪽이라 error
  // (병합 전 코드 리뷰 5 — 이 경로가 통째로 실패하면 편집 화면이 조용히 혼자 편집으로 떨어진다)
  'auth.config_failed',
  // 세션 파기 버스
  'session.revoke_failed',
  // 메일
  'mail.unconfigured',
  'mail.rejected',
  'mail.failed',
  'mail.mock_sent',
  'mail.bad_recipient',
  'mail.mention_failed',
  // 사내 LLM
  'llm.ask_failed',
  'llm.ask_error',
  'llm.save_failed',
  'llm.audit_failed',
  'llm.sweep_done',
  'llm.sweep_failed',
  // 실시간 편집
  'collab.disabled',
  'collab.enabled',
  'collab.save_failed',
  'collab.save_invalid',
  'collab.upgrade_failed',
  'collab.state_stale',
  'collab.state_discarded',
  'collab.makers_failed',
  'collab.makers_unsure',
  'collab.apply_failed',
  'collab.gate_refused',
  'collab.gate_audit_failed',
  'collab.revoked',
  'collab.recheck_failed',
  'collab.closed',
  'collab.frame_too_large',
  'collab.scratch_failed',
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** 로그의 설계 고정값 (P11 D.2·D.3) */
export const LOG_LIMITS = {
  /** 받은 요청 식별자의 모양 — 영문·숫자·`-`, 이 길이 안에서만 쓴다(로그 줄에 그대로 들어간다) */
  requestIdMinChars: 8,
  requestIdMaxChars: 64,
  /** 맞춘 라우트가 없는 요청의 경로를 접근 로그에 이만큼만 싣는다 */
  accessLogPathMaxChars: 200,
} as const;

/**
 * 요청 식별자의 모양 (P11 D.2) — 영문·숫자·`-`, `LOG_LIMITS`의 길이 안. 앱이 받는 `X-Request-Id`의 판정과 감사 조회의 거르기가 **같은
 * 판정**을 쓴다. 로그 줄에 그대로 들어가는 값이라 줄바꿈·따옴표·공백을 받지 않는다(로그 위조). `g` 깃발이 없어 여럿이 써도 된다
 */
export const REQUEST_ID_PATTERN = new RegExp(`^[A-Za-z0-9-]{${LOG_LIMITS.requestIdMinChars},${LOG_LIMITS.requestIdMaxChars}}$`);

/** 페이지 트리 최대 깊이. 무한 중첩은 이동·경로 계산 비용을 키운다. */
export const PAGE_TREE_MAX_DEPTH = 10;

/**
 * 페이지 트리의 **자리 간격** (P14_설계서_Spaces D.1). 새 페이지는 형제의 맨 뒤 + 간격에 붙고, 옮기기는 이웃 사이의 가운데를 잡는다 — 보통 옮긴
 * 한 줄만 고친다. 틈이 없을 때만 형제 전체를 간격으로 다시 매긴다(`placeAt`). 형제마다 다시 쓰면 줄마다 검색 색인까지 다시 써서, 본문이 큰 형제
 * 300개 아래로 옮기는 데 1.2초였다(병합 전 보안 검토 1). 2의 거듭제곱이라 가운데를 거듭 잡아도 여러 번 나뉜다
 */
export const PAGE_POSITION_GAP = 1024;

/** 자리 값의 한도 — 끝으로 거듭 옮겨 이것에 닿으면 다시 매긴다. `pages.position`은 int4다 */
export const PAGE_POSITION_LIMIT = 2 ** 30;

/**
 * 한 스페이스의 트리 잠금을 기다리는 상한 (P14 D.1, FR-1503). 옮기기·만들기·지우기·되살리기가 줄을 서는데, 기다리는 동안 연결을 쥐므로 오래 기다리면
 * 남의 요청이 연결을 기다린다(T-026). 넘으면 409 — 잠시 뒤 다시 한다
 */
export const PAGE_TREE_LOCK_WAIT_MS = 2000;

/** 상태 변경 요청에 요구하는 CSRF 헤더 (CLAUDE.md 7절). 값이 아니라 헤더의 존재가 방어다. */
export const CSRF_HEADER = 'x-workfluence-request';
export const CSRF_HEADER_VALUE = '1';

/**
 * **배경 요청** 표시 (P17 설계서 A.1-8) — 사람이 하지 않고 화면이 주기로 보내는 요청(알림 수를 30초마다 묻는 것)에 붙인다. 서버는 이 표시가 붙은
 * 요청으로 **세션을 늘리지 않는다**(유휴 만료가 뜻을 잃지 않게 — `CLAUDE.md` 7절의 유휴 30분). 어느 경로든 그렇다 — 붙여서 얻는 것은 자기 세션이
 * 늘지 않는 것뿐이다. **접근 로그(앱·nginx)에서 빼는 것은 `BACKGROUND_POLL_PATH`의 GET 하나뿐이다**(5xx는 남긴다) — 표시는 누구나 붙이므로, 경로를
 * 보지 않으면 표시 하나로 모든 요청이 로그에서 사라진다(좁은 재점검)
 */
export const BACKGROUND_HEADER = 'x-wf-background';
export const BACKGROUND_HEADER_VALUE = '1';
/** 화면이 주기로 부르는 경로 — 안 읽은 알림 수. nginx 설정(`deploy/nginx.conf`의 `$wf_loggable`)에도 같은 글이 있다(`pnpm verify:docs`가 대조한다) */
export const BACKGROUND_POLL_PATH = '/api/notifications/unread-count';

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

/**
 * 알림의 종류 (P4_설계서_Admin C절 · P17 F-010 8번). DB의 `notifications.kind`는 `text`다(CHECK 없음 — `0004_admin`) — 종류는 이 목록이 정한다.
 * - `mention` — 문서·댓글에서 불렸다
 * - `password.reset.request` — 누가 로그인 화면의 비밀번호 찾기로 초기화를 요청했다. 그 사람을 **관리할 수 있는** 관리자·시스템 관리자에게
 *   간다(`canManageUser`). 요청한 사람이 `actor_id`이고 페이지는 없다
 * - `email.confirm.request` — 누가 "이메일이 기억이 안나시나요?"로 email 확인을 요청했다(P19 FR-2009). **시스템 관리자(root)만** 받고 지금 root일 때만
 *   보인다. 요청한 사람이 `actor_id`이고 페이지는 없다
 */
export const NOTIFICATION_KINDS = ['mention', 'password.reset.request', 'email.confirm.request'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 모든 화면의 알림 영역 (P17 F-010 8번) — 안 읽은 수를 이 간격마다, 그리고 화면을 옮길 때 다시 묻는다. 서버가 밀어 주는 길은 없다 */
export const NOTIFICATION_POLL_MS = 30_000;
/** 알림 영역을 펼치면 보이는 최근 알림 수. 나머지는 알림함(`/notifications`)에서 본다 */
export const NOTIFICATION_PANEL_LIMIT = 5;

/**
 * 스페이스 목록을 한 번에 받는 상한 (P14 FR-1514). 관리 콘솔의 모든 스페이스 화면이 이만큼 받고, 채우면 "찾기로 좁힌다"를 말한다 — 찾기와 상태
 * 거르기는 서버가 자르기 전에 한다(`spaceListQueryDto`)
 */
export const SPACE_LIST_MAX = 500;

/** 목록 찾기 글자의 상한 — 사용자 찾기·스페이스 찾기(서버의 조건)와 관리 화면의 찾기 칸이 같이 쓴다 */
export const LIST_SEARCH_MAX = 100;

/** 분류 이름의 상한 — 계약(`createCategoryDto`)과 화면의 분류 칸(관리 칸·관리 콘솔)이 같이 쓴다 (P15 병합 전 자체 점검 7) */
export const CATEGORY_NAME_MAX = 50;

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
  /**
   * 비밀번호 변경 — 로그인한 사람만 부르지만 센다 (P13 좁은 자체 점검 6). 변경은 그 계정의 로그인과 같은 줄에 선다(P13 D.4) — 세지 않으면
   * 세션을 쥔 사람이 틀린 현재 비밀번호를 거듭 보내 그 계정의 로그인과 변경을 뒤로 민다. 성공은 돌려준다(로그인과 같다)
   */
  changePassword: { max: 5, windowSec: 60 },
  /**
   * 비밀번호를 잊었을 때 (P19 FR-2011). 메일 재설정 요청·email 확인 요청은 관리자 요청(`recoverPassword`)과 같다 — 누구나 남의 이름으로 부를 수
   * 있는 요청이다(계정마다의 간격은 `PASSWORD_RESET`). 링크 쓰기는 틀린 비밀번호 규칙으로 다시 누를 수 있게 넉넉하다 — 값은 추측할 수 없다
   */
  resetMail: { max: 3, windowSec: 600 },
  resetPassword: { max: 10, windowSec: 600 },
  emailHelp: { max: 3, windowSec: 600 },
} as const;

/**
 * 메일 재설정 링크 (P19_설계서_Recovery A.1-4·5·7). **바꾸면 보안 판단이 바뀌는 설계 고정값**이라 운영 설정이 아니라 여기 둔다(5절 둘째 칸).
 * - `linkMinutes` — 링크의 기한. 메일이 늦게 닿아도 쓰고, 새어 나간 링크가 오래 살지 않는다
 * - `mailIntervalMinutes` — 한 계정에 메일을 다시 보내기까지. 누구나 남의 이름·email로 요청할 수 있다 — 한 사람의 메일함을 채우지 못하게
 * - `tokenBytes` — 값의 무작위 바이트. 추측할 수 없어 빠른 해시(SHA-256)로 둔다
 */
export const PASSWORD_RESET = {
  linkMinutes: 30,
  mailIntervalMinutes: 5,
  tokenBytes: 32,
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
  /** 첫 답 조각을 이만큼 기다렸으면 "답변이 늦어지고 있습니다."를 함께 보인다 (P12 FR-1301 — 사용자가 정한 값) */
  slowAnswerMs: 5_000,
} as const;

/**
 * 실시간 편집의 상한 (P12_설계서_Limits A.1-4, 보류 27). 가장 큰 정상 프레임은 접속 직후의 전체 상태다 — REST 저장 상한(2MB JSON)의 문서가
 * Yjs로 약 2MB(설계서 C.3 실측)라 편집 이력까지 8배를 둔다. 넘으면 서버가 그 연결을 닫는다(1009). 이 값이 없으면 `ws` 기본 100MiB다
 */
export const COLLAB_LIMITS = {
  maxFrameBytes: 16 * 1024 * 1024,
  /**
   * 저장하고 보기로가 싣는 **스냅숏**(base64 글자 수, P13 D.7). 상태 벡터에 지운 기록이 더해져 편집할수록 자란다 — 다만 방이 열려 있는
   * 동안만이다(모두 나가면 정본에서 다시 시작한다). JSON 본문 상한(2MB, `main.ts`)에 제목과 함께 든다. 넘으면 화면이 싣지 않는다(판정을 건너뛴다)
   */
  maxFlushSnapshotChars: 1024 * 1024,
} as const;

/**
 * 표 칸 값의 범위 (P12 A.1-5, 보류 27). `maxSpan` — `colspan`·`rowspan`, 그리고 `colwidth`의 길이. HTML 표준이 `colspan`을 읽는 상한이다(브라우저는
 * 넘는 값을 1000으로 그린다). `maxColWidthPx` — 열 너비(화면이 `width: …px`로 넣는다). 편집기가 붙여 넣은 HTML의 값을 이 범위로 줄인다
 */
export const TABLE_LIMITS = {
  maxSpan: 1000,
  maxColWidthPx: 10_000,
} as const;

/**
 * 공개 API 토큰 (docs/spinoff/public-api 계획서 Q2·Q5). 만료 상한(`maxDays`)은 운영이 더 줄일 수 있고 늘릴 수는 없다 — 기본이 상한보다 길면
 * 기본은 상한이 된다(`resolveTokenExpiry`). 한 사람 10개는 에이전트·스크립트마다 하나씩 나눠 주고도 남는 수다
 */
export const API_TOKEN_LIMITS = {
  maxPerUser: 10,
  defaultDays: 90,
  maxDays: 365,
  nameMaxChars: 100,
  /** 마지막 사용 시각은 이 초만큼 묶어 쓴다 — 요청마다 행을 고쳐 쓰지 않게. 목록이 "언제 마지막으로 썼나"를 알기엔 충분하다 */
  lastUsedResolutionSec: 60,
} as const;

/** 토큰의 scope (계획서 Q3·Q4). `write`는 `read`를 포함하고, `admin`은 관리 경로에 **더해서** 요구한다 — 읽기·쓰기를 대신하지 않는다 */
export const API_TOKEN_SCOPES = ['read', 'write', 'admin'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** JWT의 고정값. 검증은 이 발급자·대상·알고리즘만 받는다 — `alg`를 토큰이 고르게 두면 `none`·다른 키 종류로 바꿔 치는 길이 열린다 */
export const API_JWT = {
  issuer: 'workfluence',
  audience: 'workfluence-api',
  algorithm: 'HS256',
} as const;
