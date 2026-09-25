import { RELEASE_REQUIRED_FILES, parseChecksums, parseManifest, unlistedRequired, verifyChecksums } from '@workfluence/shared';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bundleFiles } from './release-files';

/**
 * 반입 묶음 검사 (FR-604).
 *
 * **반입 직전과 직후 둘 다에서 돈다.** 직전은 "제대로 만들어졌나", 직후는 "옮기다 상하지
 * 않았나"를 본다 — 같은 명령이 두 질문에 답한다.
 */
function main(): void {
  const dir = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) throw new Error('검사할 묶음 디렉토리를 인자로 준다: pnpm release:verify <디렉토리>');

  // 하위 디렉토리(`ca/`)의 파일까지 본다. **디렉토리 자체는 목록에 없다** — `readFileSync`가 디렉토리에서 `EISDIR`로 터진다
  // (같은 날짜 디렉토리에 다시 만들거나 누가 폴더를 하나 넣어 두면 검사가 죽던 길)
  const present = bundleFiles(dir);
  const missing = RELEASE_REQUIRED_FILES.filter((f) => !present.includes(f));
  const expected = parseChecksums(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'));
  const actual = Object.fromEntries(
    present.filter((f) => f !== 'SHA256SUMS').map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]),
  );
  // **체크섬 목록 자체를 먼저 본다.** 목록이 비어 있으면 아무것도 검사하지 않고 통과한다 —
  // 옮기다 잘린 `SHA256SUMS`가 그 줄들을 잃은 채 통과하던 길이다
  const problems = [
    ...missing.map((f) => `${f}: 필수 파일이 없다`),
    // `SHA256SUMS` 자신은 목록에 담을 수 없다 — 담으면 자기 해시를 자기 안에 적어야 한다
    ...unlistedRequired(
      expected,
      RELEASE_REQUIRED_FILES.filter((f) => f !== 'SHA256SUMS'),
    ),
    ...verifyChecksums(expected, actual),
  ];

  // **매니페스트를 읽어서 본다** (FR-603). 예전에는 그냥 출력만 했다 — 버전이나 git sha가
  // 빠져 있어도 검사가 통과했고, 폐쇄망 안에서 "무엇이 들어왔나"를 답할 수 없게 된다.
  // 출력은 사람이 보는 것이고, 판정은 기계가 해야 한다
  let manifest = '';
  if (!missing.includes('MANIFEST.txt')) {
    try {
      const m = parseManifest(readFileSync(join(dir, 'MANIFEST.txt'), 'utf8'));
      manifest = `버전 ${m.version} · git ${m.gitSha} · 만든 시각 ${m.builtAt} · 이미지 ${m.images.length}개`;
      if (m.images.length === 0) problems.push('MANIFEST.txt: 이미지가 한 줄도 없다');
    } catch (e) {
      problems.push(`MANIFEST.txt: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (problems.length) {
    console.error(`[verify] 실패 — ${problems.length}건\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[verify] 통과 — 필수 ${RELEASE_REQUIRED_FILES.length}개 · 체크섬 ${expected.length}개 일치`);
  console.log(`[verify] ${manifest}`);
}

main();
