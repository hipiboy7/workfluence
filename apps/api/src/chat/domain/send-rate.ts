/**
 * 연결마다 분당 보내기 한도 (NFR-240). **미끄러지는 창**이다 — 받은 시각을 들고 있다가 창이 지난 것을 버린다. 거절한 시도는 기록하지 않는다
 * (계속 두드려도 창이 밀리지 않는다). 시각은 인자로 받는다 — 시계를 읽지 않아 시험이 결정적이다
 */
export class SendRateWindow {
  private readonly at: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(nowMs: number): boolean {
    while (this.at.length > 0 && nowMs - this.at[0]! >= this.windowMs) this.at.shift();
    if (this.at.length >= this.limit) return false;
    this.at.push(nowMs);
    return true;
  }
}
