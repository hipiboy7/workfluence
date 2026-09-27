/**
 * 한 열쇠씩 줄 세우기 (A등급, P13 D.4, FR-1431).
 *
 * **한 계정의 로그인은 하나씩 확인한다.** 줄 안에서 잠금을 새로 읽으므로, 동시에 틀린 N건이 와도 확인까지 가는 것은 잠금 기준만큼이다
 * (측정 S3 — 확인 뒤에 읽고 계산해 쓰던 때는 동시에 틀린 10건이 1회로 세졌다). 맞는 로그인은 차례로 모두 들어간다 — "확인하기 전에
 * 센다"는 같은 계정의 맞는 동시 로그인까지 잠가서 거뒀다(T-026 시험이 잡았다). 다른 열쇠끼리는 줄을 서지 않는다.
 *
 * **기다리는 동안 DB 연결을 쥐지 않는다** — 줄은 메모리의 약속 사슬이다. 앱 서버는 한 대다(`CLAUDE.md` 0.1 — 이중화하지 않는다).
 * 여러 프로세스가 되면 이 줄은 프로세스마다다 — 그래도 실패 횟수는 DB가 한 문장으로 올리므로 잃지는 않는다.
 *
 * **끝난 열쇠는 지운다** — 로그인한 적 있는 이름이 메모리에 쌓이지 않게. 실패한 작업도 줄을 푼다.
 */
export class KeyedSerial {
  private readonly tails = new Map<string, Promise<void>>();

  /** 줄이 남아 있는 열쇠 수 */
  get size(): number {
    return this.tails.size;
  }

  async run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = before.then(() => mine);
    this.tails.set(key, tail);
    await before;
    try {
      return await task();
    } finally {
      release();
      // 내 뒤에 아무도 서지 않았으면 지운다 — 섰으면 그 사람의 꼬리가 이미 자리를 차지했다
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
