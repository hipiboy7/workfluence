import type { OutgoingMail } from './domain/request';

/**
 * 메일 발송 인터페이스 (P6_설계서_Collab FR-751).
 *
 * **인증 제공자와 같은 축이다** (2절 DIP 표). 바뀔 수 있는 것(사내 메일 API — P18)을 토큰 뒤에 두고 상위 로직은 구체 구현을 import하지 않는다.
 *
 * 인터페이스를 **작게** 둔다 (ISP). 호출부가 필요한 것은 "보내라" 하나뿐이다 — 첨부·HTML 본문·수신 확인은 요구가 없다.
 * 한 통에 받는 사람 하나다(P18 A.1-3). 평문과 마크다운을 함께 넘기고 보내는 쪽이 설정(`WF_MAIL_FORMAT`)으로 고른다(P18 FR-1901)
 */
export const MAIL_SENDER = Symbol('MAIL_SENDER');

/** **문서 본문을 담지 않는다** (FR-755) — 메일은 앱 밖으로 나간다 */
export type MailMessage = OutgoingMail;

export interface MailSender {
  /** 보낸다. **던지지 않는다** — 실패는 `false`로 답한다 (FR-753) */
  send(message: MailMessage): Promise<boolean>;
}
