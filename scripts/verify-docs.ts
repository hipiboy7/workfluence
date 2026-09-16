/**
 * pnpm verify:docs — 문서에 적힌 명령·경로·링크가 실제로 동작하는지 기계가 검사한다 (FR-082).
 *
 * 왜 필요한가
 * -----------
 * 개발할 때 쓴 명령과 문서에 적은 명령이 다르면 **실패하는 것은 독자뿐이고 작성자는 모른다.**
 * 이 저장소는 Windows(개발)와 Linux(빌드·운영)를 오가므로 경로·명령이 어긋나기 쉽다.
 * 사람이 매번 대조하는 것은 신뢰할 수 없어 기계에 맡긴다 (CLAUDE.md 4.1절).
 *
 * 검사 항목
 * --------
 * 1. pnpm 명령(본문 인라인)   `pnpm <script>`의 스크립트가 package.json에 있는가
 * 2. pnpm 명령(코드블록)      같음. 코드블록 안은 인라인 검사에 걸리지 않는다
 * 3. 저장소 경로              백틱 안 경로가 **저장소에 커밋돼 있는가** (대소문자까지)
 * 4. 마크다운 링크            상대 링크가 실제 파일을 가리키는가
 * 5. 표 열 수                 헤더와 각 행의 열 수가 같은가
 * 6. 셸 스크립트 실행 권한     deploy/*.sh가 존재하고 실행 가능한가
 *
 * 사용법
 * -----
 *     pnpm verify:docs
 *     pnpm verify:docs -- --path docs/scope-definition.md
 *
 * 종료 코드: 0 이상 없음 / 1 위반 있음
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 검사 대상. 작업 기록은 PR 설명에 쓰므로 저장소에 별도 기록 디렉토리를 두지 않는다 (CLAUDE.md 12.1절). */
// git 패스펙에서 `docs/**/*.md`는 하위 디렉토리만 잡는다. 최상위 `docs/*.md`를 따로 적어야 한다.
const INCLUDE = ['README.md', 'CLAUDE.md', 'PROTOTYPE.md', 'docs/*.md', 'docs/**/*.md'];
// PROTOTYPE.md는 exp/prototype 브랜치에만 있다. 목록에 두어도 `git ls-files`가 없는 파일을 내놓지 않는다.

/**
 * 검사에서 빼는 파일.
 * - `docs/prompts/prototype-*`: 다른 브랜치(exp/prototype)의 코드 경로를 가리키는 기록이다.
 *   이 브랜치에 그 파일이 없는 것이 정상이므로 경로 검사를 적용하지 않는다.
 */
const SKIP = [/^docs[\\/]prompts[\\/]prototype-/];

/**
 * 백틱 경로로 인정하는 접두. 이 밖의 문자열은 경로가 아니라고 본다.
 * `.local/`은 **런타임 데이터**(git 무시)라 갓 클론한 저장소에는 없다. 저장소 경로로 검사하지 않는다.
 */
const REPO_PREFIXES = ['apps/', 'packages/', 'scripts/', 'e2e/', 'deploy/', 'docs/', '.claude/', '.github/'];

/** pnpm 내장 명령. 스크립트 이름이 아니므로 package.json에서 찾지 않는다. */
const PNPM_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'exec', 'dlx', 'store', 'audit', 'why', 'list', 'ls',
  'link', 'unlink', 'deploy', 'approve-builds', 'licenses', 'outdated', 'prune', 'rebuild', 'setup', 'env', 'config',
]);

type Finding = { file: string; line: number; kind: string; detail: string };

function listDocs(): string[] {
  // core.quotepath=false: 한글 파일명을 8진 이스케이프(ì¤...)로 내놓지 않게 한다.
  // 그대로 두면 파일을 못 찾아 **조용히 건너뛴다** — 검사되지 않은 문서가 통과로 보인다.
  const out = execSync(`git -c core.quotepath=false ls-files ${INCLUDE.map((p) => `"${p}"`).join(' ')}`, { cwd: ROOT, encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((p) => !SKIP.some((re) => re.test(p.replace(/\//g, '\\'))) && !SKIP.some((re) => re.test(p)));
}

/**
 * git이 추적하는 파일과 그 상위 디렉토리 집합.
 *
 * 경로 검사를 "디스크에 있는가"로 하면 **개발 PC에만 있는 것**(빌드 산출물·런타임 데이터)이 통과하고
 * 갓 클론한 CI에서만 실패한다. 실제로 두 번 겪었다 — 런타임 데이터 디렉토리와 빌드 산출물 디렉토리.
 * 또 Windows는 대소문자를 구분하지 않아 철자가 다른 경로도 통과시킨다. Linux에서는 깨진다.
 * 그래서 **저장소에 커밋된 목록**과 대소문자까지 정확히 대조한다.
 */
function trackedPaths(): Set<string> {
  const out = execSync('git -c core.quotepath=false ls-files', { cwd: ROOT, encoding: 'utf8' });
  const set = new Set<string>();
  for (const file of out.split(/\r?\n/).filter(Boolean)) {
    set.add(file);
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return set;
}

function packageScripts(): Set<string> {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return new Set(Object.keys(pkg.scripts ?? {}));
}

/** `pnpm x`, `pnpm run x`, `pnpm --filter y run x`에서 스크립트 이름을 뽑는다. 알 수 없으면 null */
function pnpmScriptName(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== 'pnpm') return null;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'run') {
      i++;
      continue;
    }
    if (t.startsWith('-')) {
      // --filter <name>, -r, --parallel 등
      i += t.includes('=') || !tokens[i + 1] || tokens[i + 1].startsWith('-') ? 1 : 2;
      continue;
    }
    break;
  }
  const name = tokens[i];
  if (!name) return null;
  // `pnpm <script>` 같은 자리표시자는 명령이 아니다
  if (/[<>{}*]/.test(name)) return null;
  // pnpm 내장 명령은 검사 대상이 아니다
  if (PNPM_BUILTINS.has(name)) return null;
  return name;
}

/**
 * 저장소 경로로 볼 문자열인가.
 *
 * 접두 비교는 **대소문자를 무시**한다. `Docs/...`처럼 첫 글자가 틀린 경로를 "경로가 아니다"로
 * 흘려보내면 Linux에서만 깨지는 오타를 놓친다. 경로로 인정한 뒤 커밋 목록과 정확히 대조해 잡는다.
 */
function isRepoPath(value: string): boolean {
  const lower = value.toLowerCase();
  return REPO_PREFIXES.some((p) => lower.startsWith(p)) && !/[{}*<>|?"]/.test(value);
}

function checkFile(file: string, scripts: Set<string>, tracked: Set<string>, findings: Finding[]): void {
  const abs = resolve(ROOT, file);
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  let fence: string | null = null;
  const tableHeaders: { cols: number; line: number }[] = [];

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const fenceMatch = raw.match(/^\s*```(\w*)/);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1] || 'text' : null;
      return;
    }

    // 2. 코드블록 안 pnpm 명령
    if (fence !== null) {
      if (['bash', 'sh', 'shell', 'text', 'console'].includes(fence)) {
        const cmd = raw.trim().replace(/^[$#]\s*/, '');
        if (cmd.startsWith('pnpm ')) {
          const name = pnpmScriptName(cmd);
          if (name && !scripts.has(name)) findings.push({ file, line: lineNo, kind: 'pnpm 스크립트 없음', detail: `${cmd} → package.json에 "${name}" 없음` });
        }
      }
      return;
    }

    // 1·3. 백틱 안 내용: pnpm 명령과 저장소 경로
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const value = m[1].trim();
      if (value.startsWith('pnpm ')) {
        const name = pnpmScriptName(value);
        if (name && !scripts.has(name)) findings.push({ file, line: lineNo, kind: 'pnpm 스크립트 없음', detail: `${value} → package.json에 "${name}" 없음` });
      } else if (isRepoPath(value)) {
        const target = value.replace(/[),.]+$/, '').replace(/\/+$/, '');
        // 존재 여부가 아니라 **커밋된 목록**과 대조한다 (환경·대소문자 무관)
        if (!tracked.has(target)) findings.push({ file, line: lineNo, kind: '경로가 저장소에 없음', detail: target });
      }
    }

    // 4. 마크다운 상대 링크
    for (const m of raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = decodeURIComponent(m[1].split('#')[0].trim());
      if (!href || /^(https?:|mailto:|#)/.test(href)) continue;
      const target = resolve(abs, '..', href);
      if (!existsSync(target)) findings.push({ file, line: lineNo, kind: '링크 깨짐', detail: href });
    }

    // 5. 표 열 수
    if (/^\s*\|/.test(raw)) {
      // 인라인 코드(`...`) 안의 파이프는 열 구분자가 아니다. 먼저 지우고 센다.
      const cells = raw.trim().replace(/`[^`]*`/g, '');
      const cols = cells.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length;
      const isSeparator = /^\s*\|[\s:|-]+\|\s*$/.test(cells.trim() || raw);
      const head = tableHeaders[tableHeaders.length - 1];
      if (!head || head.line < lineNo - 1) {
        tableHeaders.push({ cols, line: lineNo });
      } else if (!isSeparator && cols !== head.cols) {
        findings.push({ file, line: lineNo, kind: '표 열 수 불일치', detail: `헤더 ${head.cols}열(${head.line}행) vs 이 행 ${cols}열` });
        head.line = lineNo;
      } else {
        head.line = lineNo;
      }
    }
  });
}

/** 6. deploy/*.sh 실행 권한 */
function checkShellScripts(findings: Finding[]): void {
  const out = execSync('git -c core.quotepath=false ls-files "deploy/*.sh" "deploy/**/*.sh"', { cwd: ROOT, encoding: 'utf8' });
  for (const rel of out.split(/\r?\n/).filter(Boolean)) {
    const mode = execSync(`git ls-files -s "${rel}"`, { cwd: ROOT, encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (mode !== '100755') findings.push({ file: rel, line: 0, kind: '실행 권한 없음', detail: `git mode ${mode} (100755 필요)` });
    if (!existsSync(resolve(ROOT, rel))) findings.push({ file: rel, line: 0, kind: '파일 없음', detail: rel });
  }
}

function main(): void {
  const argPath = process.argv.indexOf('--path');
  const scripts = packageScripts();
  const tracked = trackedPaths();
  const docs = argPath >= 0 ? [relative(ROOT, resolve(process.argv[argPath + 1]))] : listDocs();
  const findings: Finding[] = [];

  let checked = 0;
  for (const doc of docs) {
    const abs = resolve(ROOT, doc);
    // 목록에 있는데 열 수 없으면 조용히 넘기지 않는다. 검사되지 않은 문서가 통과로 보이면 관문이 무의미하다.
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      findings.push({ file: doc, line: 0, kind: '문서를 읽을 수 없음', detail: '목록에는 있으나 파일이 없다 (경로 인코딩 문제일 수 있다)' });
      continue;
    }
    checkFile(doc, scripts, tracked, findings);
    checked++;
  }
  if (argPath < 0) checkShellScripts(findings);

  if (findings.length === 0) {
    console.log(`verify:docs — 문서 ${checked}개 검사, 위반 없음`);
    return;
  }
  for (const f of findings) console.error(`${f.file}:${f.line}  [${f.kind}] ${f.detail}`);
  console.error(`\nverify:docs — 위반 ${findings.length}건`);
  process.exit(1);
}

main();
