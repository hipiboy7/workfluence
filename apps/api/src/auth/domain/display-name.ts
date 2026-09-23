/**
 * IdP가 준 표시 이름을 우리 규칙에 맞춘다 (P7 FR-807, 보안 검토 F4).
 *
 * **거부하지 않고 고친다.** 로그인 자체를 막으면 IdP 쪽 프로필 하나 때문에 사람이
 * 시스템에 들어오지 못한다. 줄바꿈·제어문자를 공백으로 바꾸고 길이를 자른다.
 * 그러고도 비면 `sub`를 쓴다 — 빈 이름은 화면에서 누가 누군지 알 수 없게 만든다.
 */
function stripControl(v: string, replacement: string): string {
  // **정규식을 쓰지 않는다.** 제어문자 범위를 정규식에 적으면 lint가 막는다
  // (`no-control-regex`) — 그 규칙이 있는 이유는 보통 실수로 들어가기 때문이고,
  // 여기서는 일부러 지우는 것이므로 코드 포인트로 고른다
  return [...v].map((ch) => (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0) === 0x7f ? replacement : ch)).join('');
}

export function safeDisplayName(raw: string, fallback: string): string {
  const cleaned = stripControl(raw, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return cleaned || stripControl(fallback, '').slice(0, 100) || '사용자';
}
