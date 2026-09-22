import { Global, Module } from '@nestjs/common';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { HttpMailSender } from './http.sender';
import { MAIL_SENDER } from './mail.provider';
import { MentionMailService } from './mention-mail.service';
import { MockMailSender } from './mock.sender';

/**
 * 메일 발송 배선 (P6_설계서_Collab B.5절).
 *
 * OIDC 제공자와 **같은 모양**이다 — 모의와 실제를 둘 다 만들어 두고 설정이 고른다.
 * 꺼져 있으면 모의를 준다: `null`을 주면 호출부가 매번 `if`를 쓰게 되고, 그 `if`를
 * 빠뜨린 곳이 런타임에 터진다 (2절 LSP).
 */
@Global()
@Module({
  providers: [
    MockMailSender,
    HttpMailSender,
    {
      provide: MAIL_SENDER,
      inject: [APP_ENV, MockMailSender, HttpMailSender],
      useFactory: (env: AppEnvToken, mock: MockMailSender, http: HttpMailSender) =>
        !env.WF_MAIL_ENABLED || env.WF_MAIL_MOCK ? mock : http,
    },
    MentionMailService,
  ],
  exports: [MAIL_SENDER, MentionMailService],
})
export class MailModule {}
