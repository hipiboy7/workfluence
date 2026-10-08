/**
 * 정렬한 YAML 직렬화 (docs/spinoff/public-api 설계서 3.3-1절) — 공개 API 명세를 저장소에 파일로 두고 **diff가 줄 단위로 안정되게** 하려는 것이다.
 * 객체의 키는 항상 정렬하고(같은 명세는 늘 같은 글), 배열의 순서는 그대로 둔다. 여러 줄 글은 블록(`|`)으로 써서 줄마다 diff가 난다.
 * JSON에서 나올 수 있는 값(객체·배열·문자열·숫자·불리언·null)만 안다. 순수 함수 — 파일은 쓰지 않는다.
 */

/** 따옴표 없이 써도 YAML이 문자열로 읽는 글 — 영숫자·`_`·`.`·`-`로 이루어지고 예약어·숫자꼴이 아닌 것 */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return PLAIN.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
  return String(v);
}

/** 블록(`|-`)으로 써도 그대로 돌아오는 여러 줄 글인가 — 앞이 공백이거나 줄바꿈으로 끝나거나 제어 문자가 있으면 따옴표 글로 쓴다 */
function blockable(s: string): boolean {
  if (!s.includes('\n') || /^\s/.test(s) || s.endsWith('\n')) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch !== '\n' && (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029)) return false;
  }
  return true;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emit(v: unknown, indent: number, out: string[], lead: string): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return void out.push(`${lead}[]`);
    v.forEach((item, i) => {
      const head = i === 0 ? lead : pad;
      if (isObject(item) && Object.keys(item).length > 0) emit(item, indent + 2, out, `${head}- `);
      else if (Array.isArray(item) && item.length > 0) emit(item, indent + 2, out, `${head}- `);
      else out.push(`${head}- ${inline(item)}`);
    });
    return;
  }
  if (isObject(v)) {
    const keys = Object.keys(v).sort();
    if (keys.length === 0) return void out.push(`${lead}{}`);
    keys.forEach((k, i) => {
      const head = i === 0 ? lead : pad;
      const val = v[k];
      const key = scalar(k);
      if (typeof val === 'string' && blockable(val)) {
        out.push(`${head}${key}: |-`);
        for (const line of val.split('\n')) out.push(line === '' ? '' : `${pad}  ${line}`);
      } else if ((isObject(val) && Object.keys(val).length > 0) || (Array.isArray(val) && val.length > 0)) {
        out.push(`${head}${key}:`);
        emit(val, indent + 2, out, `${pad}  `);
      } else {
        out.push(`${head}${key}: ${inline(val)}`);
      }
    });
    return;
  }
  out.push(`${lead}${inline(v)}`);
}

/** 한 줄로 쓰는 값 — 빈 객체·빈 배열도 */
function inline(v: unknown): string {
  if (Array.isArray(v)) return '[]';
  if (isObject(v)) return '{}';
  return scalar(v as string | number | boolean | null);
}

export function toSortedYaml(value: unknown): string {
  const out: string[] = [];
  emit(JSON.parse(JSON.stringify(value)) as unknown, 0, out, '');
  return `${out.join('\n')}\n`;
}
