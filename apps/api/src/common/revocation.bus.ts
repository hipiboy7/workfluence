import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { errorText } from './error-text';

/**
 * 세션을 끊었다는 사실을 **아무것도 import하지 않는 가운데 지점**에 알린다
 * (P7_설계서_Hardening C.1.1절, FR-805).
 *
 * **왜 직접 부르지 않는가.** 비밀번호를 바꾸거나 관리자가 세션을 강제 종료하면
 * HTTP 쪽은 즉시 401이 되는데 **이미 열려 있는 편집용 WebSocket은 그대로 산다**
 * (Phase 6 보안 검토 발견 1). 그렇다고 `UsersService`가 게이트웨이를 부르면
 * **인증 모듈이 실시간 편집에 묶인다** — 실시간 편집은 끌 수 있는 기능이고
 * (`WF_COLLAB_ENABLED=false`) 끌 수 있는 것에 인증이 의존하면 그것은 끌 수 있는 것이 아니다.
 *
 * 그래서 버스는 **양쪽 중 누구도 모른다.** 끊는 쪽이 `revoke()`를 부르고,
 * 듣고 싶은 쪽이 `onRevoke()`로 붙는다.
 *
 * **이것이 주기 재판정을 대신하지 않는다.** 여기로 오는 것은 "끊는 동작"이 있는
 * 경우뿐이다. Crew에서 빠지는 것·스페이스 중지·계정 만료에는 부를 자리가 없어
 * 게이트웨이의 주기 재판정(C.1절)이 따로 본다.
 */
@Injectable()
export class RevocationBus {
  private readonly log = new Logger('Revocation');
  private readonly listeners = new Set<(userId: string, sid?: string) => void>();

  /** 구독을 해제하는 함수를 돌려준다 */
  onRevoke(fn: (userId: string, sid?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 이 사용자의 세션이 파기됐다.
   *
   * **`sid`를 주면 그 세션만이다.** 로그아웃은 누른 그 브라우저의 세션 하나만 지우므로
   * (`req.session.destroy()`), 그 사람의 다른 기기 편집까지 끊으면 안 된다.
   * 비밀번호 변경·관리자 강제 종료는 전부 지우므로 `sid` 없이 부른다.
   *
   * **구독자가 던져도 삼킨다.** 이 호출은 비밀번호 변경 트랜잭션 뒤에 오는데,
   * 듣는 쪽의 사정으로 비밀번호 변경이 실패하면 안 된다.
   */
  revoke(userId: string, sid?: string): void {
    for (const fn of this.listeners) {
      try {
        fn(userId, sid);
      } catch (e) {
        this.log.warn(`세션 파기 통지 처리 실패 (user=${userId}): ${errorText(e)}`);
      }
    }
  }
}

@Global()
@Module({ providers: [RevocationBus], exports: [RevocationBus] })
export class RevocationModule {}
