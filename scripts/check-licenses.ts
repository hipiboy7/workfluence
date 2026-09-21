/**
 * pnpm licenses:check — 의존성 라이선스 검사 (FR-093).
 *
 * 폐쇄망 내부 시스템이라 반입 묶음에 라이선스 목록을 넣어야 하고, 강한 카피레프트(GPL·AGPL·SSPL)나
 * 상용 라이선스가 섞이면 반입 자체가 막힌다. 나중에 걸리면 대체 라이브러리를 찾느라 설계가 흔들리므로
 * CI에서 매번 본다.
 *
 * 종료 코드: 0 허용 라이선스만 / 1 허용 밖 발견
 */
import { execSync } from 'node:child_process';

/**
 * 허용 라이선스. **`CLAUDE.md` 7절 목록과 같아야 한다.**
 * 규칙보다 넓히면 관문이 규칙을 대신 정하게 된다 — 넓히려면 규칙을 먼저 고친다.
 */
const ALLOWED = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD'];

/**
 * 허용 목록 밖이지만 승인해 통과시키는 개별 패키지. **사유와 확인 일자를 반드시 적는다.**
 * 목록을 넓히는 대신 여기에 적는 이유: 무엇을 왜 예외로 두었는지가 남아야 다음 사람이 재검토할 수 있다.
 */
const EXCEPTIONS: Record<string, string> = {
  // 예: 'some-package@1.0.0': '듀얼 라이선스 중 MIT 선택. 2026-09-16 확인'
};

type Entry = { name: string; versions?: string[]; license?: string };

function main(): void {
  const raw = execSync('pnpm licenses list --json --prod', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(raw) as Record<string, Entry[]> | Entry[];
  const groups: [string, Entry[]][] = Array.isArray(parsed)
    ? [['(unknown)', parsed]]
    : Object.entries(parsed);

  const violations: string[] = [];
  let total = 0;

  for (const [license, entries] of groups) {
    for (const entry of entries) {
      total++;
      const lic = entry.license ?? license;
      const id = `${entry.name}@${(entry.versions ?? []).join(',') || '?'}`;
      if (ALLOWED.includes(lic)) continue;
      if (EXCEPTIONS[id]) {
        console.log(`허용(예외) ${id} — ${lic}: ${EXCEPTIONS[id]}`);
        continue;
      }
      violations.push(`${id} — ${lic}`);
    }
  }

  if (violations.length === 0) {
    console.log(`licenses:check — production 의존성 ${total}개, 허용 라이선스만 사용`);
    return;
  }
  console.error('허용 목록 밖 라이선스:');
  for (const v of violations) console.error(`  ${v}`);
  console.error(`\n허용: ${ALLOWED.join(', ')}`);
  console.error('승인하려면 scripts/check-licenses.ts의 EXCEPTIONS에 사유와 함께 등재한다.');
  process.exit(1);
}

main();
