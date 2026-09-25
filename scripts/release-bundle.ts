import { RELEASE_REQUIRED_FILES, formatChecksums, formatManifest } from '@workfluence/shared';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bundleFiles } from './release-files';

/**
 * 반입 묶음 (P5_설계서_Release B절, FR-600~609).
 *
 * **사람이 파일을 모으면 빠뜨린다.** 반입은 한 번에 한 묶음만 들어가고, 빠진 것이 있으면
 * 폐쇄망 안에서 되돌릴 방법이 없다 — 그래서 목록을 코드가 들고 있다.
 *
 * **인터넷을 쓰지 않는다** (FR-607). 이미 받아 둔 이미지와 설치된 의존성만 쓴다.
 */
/**
 * 이미지 목록을 **compose에게 물어본다** (`config --images`).
 *
 * 예전에는 여기에 세 이름을 적어 뒀다. 그러면 compose의 태그를 올리는 순간 **`docker save`는
 * 옛 이미지를 저장하고**(로컬에 있으니 오류도 안 난다) 매니페스트도 같은 상수에서 나오므로
 * 검사가 어긋남을 못 잡는다. 폐쇄망에서 `up -d`가 "이미지 없음"으로 죽고, 거기서는 두 번째
 * 시도가 없다 (코드 리뷰 3). 이제 **compose가 요구하는 것만** 저장된다.
 */
function composeImages(): string[] {
  return sh('docker', [...COMPOSE_ARGS, 'config', '--images'], true)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

const COMPOSE_ARGS = ['compose', '-f', 'deploy/compose.yml', '--env-file', 'deploy/.env'] as const;

const sh = (cmd: string, args: string[], capture = false): string => {
  const r = execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
  return capture ? r.toString().trim() : '';
};

function main(): void {
  const out = resolve(process.argv[2] ?? join('.local', 'release', new Date().toISOString().slice(0, 10)));
  mkdirSync(out, { recursive: true });
  const gitSha = sh('git', ['rev-parse', '--short', 'HEAD'], true);
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  console.log(`[release] ${out} — ${version} / ${gitSha}`);

  // 이미지를 **하나의 tar로** 묶는다. 따로 두면 하나만 빠뜨린 채 반입된다
  const images = composeImages();
  if (images.length === 0) throw new Error('compose가 요구하는 이미지를 하나도 찾지 못했다');
  console.log(`[release] 이미지 저장 중… (${images.join(', ')})`);
  sh('docker', ['save', '-o', join(out, 'images.tar'), ...images]);

  copyFileSync('deploy/compose.yml', join(out, 'compose.yml'));
  copyFileSync('deploy/nginx.conf', join(out, 'nginx.conf'));
  copyFileSync('docs/운영가이드_반입.md', join(out, '반입절차.md'));
  // **사내 CA 자리** (P11 D.7) — 안내 파일만 넣어 `ca/`가 풀린 사람의 것으로 생기게 한다. 묶음에 없으면 첫 기동에서 도커가 root 소유로
  // 만들어, 현장에서 인증서를 넣을 때 일반 계정은 `Permission denied`다. **인증서는 넣지 않는다** — 현장의 것이다(`certs`와 같다)
  mkdirSync(join(out, 'ca'), { recursive: true });
  copyFileSync('deploy/ca/README.md', join(out, 'ca', 'README.md'));

  // `.env` 템플릿에는 **값이 하나도 없다** (FR-606). 키와 설명만 간다.
  //
  // **개발용 `.env.example`을 그대로 쓰지 않는다.** 그 파일은 `pnpm dev`가 쓰는 키(임베디드
  // DB 경로·테스트 DB URL·모의 OIDC 같은 것)를 담고 있고, compose는 그것을 읽지 않는다 —
  // 작업자가 채워도 아무 효과가 없다. 반대로 **compose가 요구하는 키가 빠져 있었다**
  // (`WF_PG_PASSWORD` 등). 값이 없으면 `${VAR:?}` 때문에 기동이 거부되는데, 템플릿에
  // 그 키가 없으니 작업자는 무엇을 채워야 하는지 알 수 없다. 그래서 **compose 파일에서
  // 실제로 참조하는 변수**를 뽑아 그것만 넣는다 — 목록이 코드와 어긋날 수 없다.
  // 변수 목록도 **compose에게 물어본다** (`config --variables`). YAML을 우리가 파싱하면
  // `build:` 뒤에 주석이 붙는 것만으로 헤매고, 중괄호 없는 `$VAR`는 아예 놓친다 —
  // 놓치는 쪽이 위험하다. 키가 템플릿에 없으면 작업자가 채우지 않고, 값이 빈 채로
  // **앱이 잘못 설정된 상태로 뜬다** (코드 리뷰 7).
  //
  // 걸러내는 기준은 이름 목록이 아니라 **규칙**이다: 앱 설정은 전부 `WF_` 접두사다
  // (CLAUDE.md 5절). `WF_`가 아닌 것(프록시 등)은 빌드·인프라 배선이고 폐쇄망에서
  // 채울 것이 아니다. 손으로 관리하는 제외 목록을 두지 않는다 (T-024).
  const referenced = sh('docker', [...COMPOSE_ARGS, 'config', '--variables'], true)
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => /^WF_[A-Z0-9_]*$/.test(n));

  const exampleComments = new Map<string, string>();
  {
    let pending: string[] = [];
    for (const line of readFileSync('.env.example', 'utf8').split('\n')) {
      if (line.startsWith('#')) pending.push(line);
      else if (/^[A-Z][A-Z0-9_]*=/.test(line)) {
        exampleComments.set(line.split('=')[0], pending.join('\n'));
        pending = [];
      } else pending = [];
    }
  }
  const keys = [...new Set(referenced)].sort();
  const body = keys
    .map((k) => {
      const c = exampleComments.get(k);
      return `${c ? `${c}\n` : ''}${k}=`;
    })
    .join('\n');
  writeFileSync(
    join(out, 'env.template'),
    [
      '# 폐쇄망에서 값을 채운다. 비어 있으면 기동 시 거부된다.',
      '# 이 목록은 deploy/compose.yml이 실제로 참조하는 변수에서 뽑았다 — 여기 없는 키는 이 배포가 쓰지 않는다.',
      '',
      body,
      '',
    ].join('\n'),
  );
  console.log(`[release] env.template — compose가 요구하는 키 ${keys.length}개`);

  // SBOM·라이선스 — 설치된 의존성에서 만든다. 네트워크를 쓰지 않는다
  console.log('[release] SBOM 생성 중…');
  const licenses = JSON.parse(sh('pnpm', ['licenses', 'list', '--prod', '--json'], true)) as Record<
    string,
    { name: string; version: string; versions?: string[] }[]
  >;
  const components: { type: string; name: string; version: string; licenses: { license: { id: string } }[] }[] = [];
  const lines: string[] = [];
  for (const [license, pkgs] of Object.entries(licenses)) {
    for (const p of pkgs) {
      const v = p.versions?.[0] ?? p.version ?? '?';
      components.push({ type: 'library', name: p.name, version: v, licenses: [{ license: { id: license } }] });
      lines.push(`${license.padEnd(16)} ${p.name}@${v}`);
    }
  }
  writeFileSync(
    join(out, 'sbom.cdx.json'),
    JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { component: { type: 'application', name: 'workfluence', version } }, components }, null, 2) + '\n',
  );
  writeFileSync(join(out, 'LICENSES.txt'), `workfluence ${version} (${gitSha}) — production 의존성 ${components.length}개\n\n${lines.sort().join('\n')}\n`);

  writeFileSync(join(out, 'MANIFEST.txt'), formatManifest({ version, gitSha, builtAt: new Date().toISOString(), images }));

  // 체크섬은 **마지막에**. SHA256SUMS 자신은 목록에 넣지 않는다. 하위 디렉토리(`ca/`)의 파일까지 담는다(`bundleFiles`)
  const files = bundleFiles(out).filter((f) => f !== 'SHA256SUMS');
  writeFileSync(
    join(out, 'SHA256SUMS'),
    formatChecksums(files.map((f) => ({ file: f, sha256: createHash('sha256').update(readFileSync(join(out, f))).digest('hex') }))),
  );

  const present = bundleFiles(out);
  const missing = RELEASE_REQUIRED_FILES.filter((f) => !present.includes(f));
  if (missing.length) throw new Error(`묶음에 빠진 것이 있다: ${missing.join(', ')}`);

  const bytes = present.reduce((n, f) => n + statSync(join(out, f)).size, 0);
  console.log(`[release] 완료 — ${present.length}개 파일 · ${(bytes / 1024 / 1024).toFixed(0)}MB`);
  console.log(`[release] 반입 직전·직후에 'pnpm release:verify ${out}'를 돌린다`);
}

main();
