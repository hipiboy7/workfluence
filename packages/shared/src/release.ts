/**
 * 반입 묶음의 형식 (A등급, P5_설계서_Release D절, FR-601~604).
 *
 * 순수 함수다 — 파일을 읽지 않는다. 읽고 쓰는 것은 스크립트가 하고, **무엇이 올바른
 * 형식인가**만 여기서 정한다. 반입 심사에서 이 판정이 틀리면 손상된 묶음을 통과시킨다.
 */

export type ChecksumEntry = { file: string; sha256: string };

/** 묶음이 반드시 갖춰야 할 것 (FR-601). **사람이 모으면 빠뜨린다** */
export const RELEASE_REQUIRED_FILES = [
  'MANIFEST.txt',
  'SHA256SUMS',
  'compose.yml',
  'nginx.conf',
  'env.template',
  'sbom.cdx.json',
  'LICENSES.txt',
  '반입절차.md',
] as const;

const SHA256 = /^[0-9a-f]{64}$/;

/** `sha256sum`과 같은 서식으로 쓴다 — 우리 도구가 없어도 표준 도구로 검사할 수 있어야 한다 */
export function formatChecksums(entries: readonly ChecksumEntry[]): string {
  return entries.map((e) => `${e.sha256}  ${e.file}`).join('\n') + '\n';
}

/**
 * 읽는다. **서식이 깨진 줄은 조용히 넘기지 않는다** — 검사 파일이 상했는데 검사가
 * 통과하면 검사가 있는 것이 없는 것보다 나쁘다.
 */
export function parseChecksums(text: string): ChecksumEntry[] {
  const out: ChecksumEntry[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-f]+)\s+(.+)$/.exec(line);
    if (!m || !SHA256.test(m[1])) throw new Error(`체크섬 파일 ${i + 1}번째 줄의 서식이 잘못됐다: ${line}`);
    out.push({ file: m[2], sha256: m[1] });
  }
  return out;
}

/**
 * 대조. 돌려주는 것은 **사람이 읽을 문제 목록**이고, 비었으면 통과다.
 *
 * 목록에 없는 파일이 더 있는 것은 문제가 아니다(절차서·README가 함께 온다).
 * **목록에 있는데 없는 것은 문제다** — 반입이 불완전하다는 뜻이다.
 */
export function verifyChecksums(expected: readonly ChecksumEntry[], actual: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const e of expected) {
    const got = actual[e.file];
    if (got === undefined) problems.push(`${e.file}: 묶음에 없다`);
    else if (got !== e.sha256) problems.push(`${e.file}: 체크섬이 다르다 (기대 ${e.sha256.slice(0, 12)}…, 실제 ${got.slice(0, 12)}…)`);
  }
  return problems;
}

export type Manifest = { version: string; gitSha: string; builtAt: string; images: string[] };

const MANIFEST_KEYS = ['version', 'gitSha', 'builtAt'] as const;

export function formatManifest(m: Manifest): string {
  return [
    '# workfluence 반입 묶음',
    `version=${m.version}`,
    `gitSha=${m.gitSha}`,
    `builtAt=${m.builtAt}`,
    ...m.images.map((i) => `image=${i}`),
    '',
  ].join('\n');
}

/** **버전과 sha가 없으면 거부한다.** 무엇을 반입했는지가 나중에 유일한 단서다 (FR-603) */
export function parseManifest(text: string): Manifest {
  const kv: Record<string, string> = {};
  const images: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    if (key === 'image') images.push(value);
    else kv[key] = value;
  }
  for (const k of MANIFEST_KEYS) {
    if (!kv[k]) throw new Error(`매니페스트에 ${k}가 없다`);
  }
  return { version: kv.version, gitSha: kv.gitSha, builtAt: kv.builtAt, images };
}
