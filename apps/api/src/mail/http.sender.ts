import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import type { MailMessage, MailSender } from './mail.provider';

/**
 * 사내 메일 API 어댑터 (FR-751).
 *
 * **요청 형식은 가정이다** (P6_설계서_Collab A.1절). 사용자가 "메일 전송 API가 있다"고
 * 했고 그 형식은 아직 모른다. 틀리면 **이 파일 하나만 고친다** — 그것이 인터페이스를
 * 토큰 뒤에 둔 이유다.
 *
 * ```
 * POST {WF_MAIL_API_URL}
 * Authorization: Bearer {WF_MAIL_API_TOKEN}
 * { "from": "...", "to": ["..."], "subject": "...", "text": "..." }
 * ```
 *
 * **실연동 확인은 보류 18이다.** 모의 통과는 완료가 아니다 (9.1절과 같은 판단).
 */
@Injectable()
export class HttpMailSender implements MailSender {
  private readonly log = new Logger('Mail');

  constructor(@Inject(APP_ENV) private readonly env: AppEnvToken) {}

  async send(message: MailMessage): Promise<boolean> {
    if (!this.env.WF_MAIL_API_URL || !this.env.WF_MAIL_FROM) {
      // 켜 놓고 주소를 안 적은 상태다. **조용히 성공으로 치지 않는다**
      this.log.warn('메일이 켜져 있는데 WF_MAIL_API_URL·WF_MAIL_FROM이 비었다');
      return false;
    }
    try {
      // **시간 제한을 둔다.** 메일 서버가 안 받으면 알림 처리가 거기 묶인다 (T-026의 교훈)
      const res = await fetch(this.env.WF_MAIL_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.env.WF_MAIL_API_TOKEN ? { authorization: `Bearer ${this.env.WF_MAIL_API_TOKEN}` } : {}),
        },
        body: JSON.stringify({ from: this.env.WF_MAIL_FROM, to: message.to, subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // **응답 본문을 로그에 담지 않는다.** 무엇이 들었는지 모르는 남의 응답이다
        this.log.warn(`메일 API가 ${res.status}로 답했다`);
        return false;
      }
      return true;
    } catch (e) {
      this.log.warn(`메일 API 호출 실패: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
