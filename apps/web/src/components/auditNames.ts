import type { AuditAction } from '@workfluence/shared';

/**
 * 감사 행위의 한글 이름 (P17 설계서 J.9-9 · J.6 관리 다섯) — 코드는 개발 용어라 화면에는 "한글 (코드)" 꼴로 보인다. 코드는 장애대응 가이드·사용자 가이드·시험이
 * 찾는 이름이라 지우지 않는다. 이름은 가이드와 각 Phase 설계서의 감사 표가 쓰는 말을 따른다.
 *
 * `Record<AuditAction, string>`이라 `AUDIT_ACTIONS`에 종류가 늘면 타입이 여기를 채우라고 한다 — 빠진 종류가 코드로만 보이지 않게
 */
export const AUDIT_ACTION_NAMES: Record<AuditAction, string> = {
  'auth.login.success': '로그인 성공',
  'auth.login.failure': '로그인 실패',
  'auth.logout': '로그아웃',
  'auth.password.change': '비밀번호 변경',
  'auth.id.recover': '아이디 찾기',
  'auth.password.recover': '비밀번호 초기화 요청',
  'user.signup': '가입 요청',
  'user.create': '사용자 만들기',
  'user.approve': '가입 승인',
  'user.unlock': '잠금 해제',
  'user.password.reset': '비밀번호 초기화',
  'user.sessions.terminate': '세션 강제 종료',
  'user.role.change': '역할 변경',
  'user.grants.change': '위임 주고 거두기',
  'user.suspend': '계정 정지',
  'user.unsuspend': '정지 해제',
  'category.create': '분류 만들기',
  'space.create': '스페이스 만들기',
  'space.update': '스페이스 정보 변경',
  'space.status.change': '스페이스 중지·다시 쓰기',
  'space.delete': '스페이스 지우기',
  'space.member.add': 'Crew 추가',
  'space.member.role.change': 'Crew 역할 변경',
  'space.member.remove': 'Crew 제거',
  'page.create': '페이지 만들기',
  'page.update': '페이지 저장',
  'page.move': '페이지 옮기기',
  'page.delete': '페이지 삭제',
  // 호출하는 곳이 없는 옛 종류다(P2 자체 점검 11) — 버전 복원과 휴지통의 되살리기는 아래의 두 종류가 남긴다
  'page.restore': '페이지 복원',
  'page.version.restore': '버전 복원',
  'attachment.upload': '첨부 올리기',
  'attachment.download': '첨부 받기',
  'attachment.delete': '첨부 삭제',
  'comment.create': '댓글 쓰기',
  'comment.update': '댓글 고치기',
  'comment.delete': '댓글 삭제',
  'page.restore.trash': '휴지통에서 페이지 되살리기',
  'space.restore': '휴지통에서 스페이스 되살리기',
  'trash.purge': '휴지통 정리',
  'audit.purge': '감사로그 정리',
  'backup.create': '백업 만들기',
  'backup.restore': '백업 되살리기',
  'label.attach': '라벨 붙이기',
  'label.detach': '라벨 떼기',
  'category.update': '분류 이름 바꾸기',
  'category.delete': '분류 지우기',
  'settings.update': '운영 설정 변경',
  'page.export': 'HTML 내보내기',
  'page.collab.save': '실시간 편집 자동 저장',
  // "저장하고 보기로"가 부르는 바로 저장 — 누른 사람을 남긴다(P7 FR-815)
  'page.collab.flush': '실시간 편집 바로 저장',
  'page.collab.title': '실시간 편집 제목 바꾸기',
  'template.create': '템플릿 만들기',
  'template.update': '템플릿 고치기',
  'template.delete': '템플릿 지우기',
  'mail.send': '메일 발송 성공',
  'mail.fail': '메일 발송 실패',
  // 관문이 받지 않고 끊은 변경(P9 FR-1006)
  'page.collab.reject': '실시간 편집 거절',
  'llm.provider.create': 'LLM 연결 등록',
  'llm.provider.delete': 'LLM 연결 삭제',
  'llm.ask': 'LLM 질문',
  'llm.conversation.purge': 'LLM 대화 정리',
};

/**
 * 행위 코드의 한글 이름. 목록에 없는 코드(지금 목록에서 빠진 옛 행)는 `null` — 부른 쪽이 코드만 보인다.
 * `in`이 아니라 자기 속성만 본다 — `constructor` 같은 이름이 이름으로 읽히지 않게
 */
export function auditActionName(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(AUDIT_ACTION_NAMES, code) ? AUDIT_ACTION_NAMES[code as AuditAction] : null;
}
