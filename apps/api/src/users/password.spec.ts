import { describe, expect, it } from 'vitest';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password';

/**
 * B등급 — **더미 확인은 실제로 argon2를 돈다** (P13 FR-1432, 병합 전 자체 점검 9). 없는 계정·비밀번호 없는 계정·잠긴 계정은 이것으로
 * 한 번 도는데, 하는 척만 하면 그런 계정만 빨리 답해 응답 시간으로 계정 상태가 드러난다(측정 S0b — 잠긴 계정은 약 5ms였다). 호출됐는지만
 * 보는 시험은 "아무것도 안 하는 더미"를 잡지 못했다. **아래쪽 한계만 본다** — 느린 기계에서는 둘 다 느려질 뿐이라 흔들리지 않는다
 */
describe('burnPasswordCheck', () => {
  it('**틀린 비밀번호의 진짜 확인만큼 걸린다** — 적어도 그 4분의 1', async () => {
    const real = await hashPassword('the-real-password-1');
    const t0 = performance.now();
    await expect(verifyPassword(real, 'a-wrong-password')).resolves.toBe(false);
    const verifyMs = performance.now() - t0;

    const t1 = performance.now();
    await burnPasswordCheck('a-wrong-password');
    const burnMs = performance.now() - t1;

    expect(verifyMs).toBeGreaterThan(20);
    expect(burnMs).toBeGreaterThan(verifyMs / 4);
  });
});
