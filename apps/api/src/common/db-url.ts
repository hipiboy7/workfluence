import { URL } from 'node:url';

/**
 * 접속 문자열에서 **사람이 알아볼 수 있는 대상**만 뽑는다. 비밀번호는 담지 않는다.
 *
 * **정리 명령이 어느 데이터베이스를 지우는지 말하지 않는 것이 위험하다.** `.env`가 가리키는
 * 곳으로 붙기 때문에, 개발·빌드 공용 서버에서 컨테이너 DB를 지우려고 부르면 **말없이
 * 임베디드 개발 DB를 지운다.** 두 DB는 이름도 같고(`workfluence`) 포트만 다르다.
 * 지우는 명령은 지우기 전에 **어디를 지우는지 먼저 말해야 한다** (P5 자체 점검).
 *
 * **`config.module.ts`에 있었는데 그 파일은 커버리지 측정에서 제외된다.** 순수 함수를
 * 측정 밖에 두면 테스트가 없어도 아무도 모른다 — 그래서 여기로 옮겼다 (코드 리뷰 15).
 */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname} (사용자 ${u.username || '?'})`;
  } catch {
    return '(접속 문자열을 읽을 수 없다)';
  }
}
