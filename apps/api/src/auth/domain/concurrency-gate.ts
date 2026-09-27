/**
 * 동시 실행 상한 — 넘는 작업은 들어온 차례대로 줄을 선다 (A등급, P13 D.4, FR-1433).
 *
 * argon2는 한 건이 CPU 코어 하나를 넘게 쓴다(`p=4`). 한꺼번에 여럿을 돌려도 처리량은 그대로인데, 요청을 처리하는 스레드와 CPU를 나눠
 * 다른 사람의 요청이 늦어진다(P13 측정 S0a·S2). 그래서 한 프로세스의 해싱을 이 줄에 세운다.
 *
 * **실패한 작업도 자리를 돌려준다.** 안 돌려주면 몇 번의 실패로 로그인이 영영 줄에 선다.
 */
export class ConcurrencyGate {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`동시 실행 상한은 1 이상의 정수여야 한다 — ${limit}`);
  }

  /** 지금 도는 작업 수 */
  get active(): number {
    return this.running;
  }

  /** 줄에서 기다리는 작업 수 */
  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T> | T): Promise<T> {
    // **자리는 비우지 않고 넘긴다.** 비운 뒤 깨우면, 깨어난 작업이 자리를 잡기 전에 새로 온 작업이 먼저 잡아 상한을 넘는다
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.running += 1;
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
