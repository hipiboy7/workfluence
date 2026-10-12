import { SendRateWindow } from './send-rate';

/**
 * **사용자마다** 분당 보내기 한도 (NFR-240, 보안 검토 2). 연결마다·토큰마다 세면 연결을 끊고 다시 붙거나 토큰을 여럿 만들어 한도가 곱해진다 —
 * 화면의 REST·WebSocket·headless의 REST·WebSocket이 **한 예산**을 나눠 쓴다. 보내는 쪽(`ChatService.send`)이 이것을 부른다.
 * 시각은 인자로 받는다(결정적 시험). 쉬는 사용자의 창은 가끔 쓸어 낸다 — 맵이 사용자 수만큼만 자란다
 */
export class SendLimiter {
  private readonly windows = new Map<string, { w: SendRateWindow; last: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  take(userId: string, nowMs: number): boolean {
    if (nowMs - this.lastSweep >= this.windowMs) {
      for (const [k, e] of this.windows) if (nowMs - e.last >= this.windowMs) this.windows.delete(k);
      this.lastSweep = nowMs;
    }
    let e = this.windows.get(userId);
    if (!e) this.windows.set(userId, (e = { w: new SendRateWindow(this.limit, this.windowMs), last: nowMs }));
    const ok = e.w.take(nowMs);
    if (ok) e.last = nowMs;
    return ok;
  }

  /** 다음 보내기까지 기다릴 초(올림) — 안내용. 모르면 창 길이 */
  retryAfterSec(): number {
    return Math.ceil(this.windowMs / 1000);
  }
}
