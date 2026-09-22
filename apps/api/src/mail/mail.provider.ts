/**
 * 메일 발송 인터페이스 (P6_설계서_Collab FR-751).
 *
 * **인증 제공자와 같은 축이다** (2절 DIP 표). 사내 메일 API의 요청 형식을 아직 모르므로
 * (A.1절), 바뀔 수 있는 것을 토큰 뒤에 두고 상위 로직은 구체 구현을 import하지 않는다.
 *
 * 인터페이스를 **작게** 둔다 (ISP). 호출부가 필요한 것은 "보내라" 하나뿐이다 —
 * 첨부·HTML 본문·수신 확인은 요구가 없고, 지금 넣으면 어댑터가 그만큼 추측이 된다.
 */
export const MAIL_SENDER = Symbol('MAIL_SENDER');

export type MailMessage = {
  to: string[];
  subject: string;
  /** **평문만.** 메일은 앱 밖으로 나가므로 문서 본문을 담지 않는다 (FR-755) */
  text: string;
};

export interface MailSender {
  /** 보낸다. **던지지 않는다** — 실패는 `false`로 답한다 (FR-753) */
  send(message: MailMessage): Promise<boolean>;
}
