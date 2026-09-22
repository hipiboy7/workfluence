import { RELEASE_REQUIRED_FILES, parseChecksums, verifyChecksums } from '@workfluence/shared';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 반입 묶음 검사 (FR-604).
 *
 * **반입 직전과 직후 둘 다에서 돈다.** 직전은 "제대로 만들어졌나", 직후는 "옮기다 상하지
 * 않았나"를 본다 — 같은 명령이 두 질문에 답한다.
 */
function main(): void {
  const dir = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) throw new Error('검사할 묶음 디렉토리를 인자로 준다: pnpm release:verify <디렉토리>');

  const present = readdirSync(dir);
  const missing = RELEASE_REQUIRED_FILES.filter((f) => !present.includes(f));
  const expected = parseChecksums(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'));
  const actual = Object.fromEntries(
    present.filter((f) => f !== 'SHA256SUMS').map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]),
  );
  const problems = [...missing.map((f) => `${f}: 필수 파일이 없다`), ...verifyChecksums(expected, actual)];

  if (problems.length) {
    console.error(`[verify] 실패 — ${problems.length}건\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[verify] 통과 — 필수 ${RELEASE_REQUIRED_FILES.length}개 · 체크섬 ${expected.length}개 일치`);
  console.log(readFileSync(join(dir, 'MANIFEST.txt'), 'utf8').trim());
}

main();
