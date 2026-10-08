import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { toSortedYaml } from './yaml-dump';
import { buildOpenApi, V1_OPENAPI_INFO, V1_OPERATIONS } from './v1-spec';

describe('toSortedYaml — 키를 정렬한 YAML (명세 파일의 diff를 줄 단위로 안정시킨다)', () => {
  it('키 순서가 달라도 같은 글이 나온다', () => {
    expect(toSortedYaml({ b: 1, a: { d: 2, c: 3 } })).toBe(toSortedYaml({ a: { c: 3, d: 2 }, b: 1 }));
    expect(toSortedYaml({ b: 1, a: 2 })).toBe('a: 2\nb: 1\n');
  });

  it('배열의 순서는 그대로 둔다', () => {
    expect(toSortedYaml({ x: ['b', 'a'] })).toBe('x:\n  - b\n  - a\n');
  });

  it('빈 객체·빈 배열·null·불리언·숫자', () => {
    expect(toSortedYaml({ a: {}, b: [], c: null, d: true, e: 1.5 })).toBe('a: {}\nb: []\nc: null\nd: true\ne: 1.5\n');
  });

  it('YAML이 다르게 읽을 문자열은 따옴표로 감싼다', () => {
    const v = { s: ['true', 'null', '123', '', ' 앞공백', 'a: b', '# 주석', '/pages/{id}', '한글'] };
    expect(load(toSortedYaml(v))).toEqual(v);
  });

  it('여러 줄 글은 블록으로 쓰고 그대로 돌아온다', () => {
    const v = { d: '첫 줄\n  들여쓴 줄\n\n끝 줄' };
    const y = toSortedYaml(v);
    expect(y).toContain('d: |-');
    expect(load(y)).toEqual(v);
  });

  it('줄바꿈으로 끝나거나 앞이 공백인 여러 줄 글도 그대로 돌아온다', () => {
    const v = { a: '끝\n', b: ' 앞\n뒤', c: 'x\r\ny', d: '탭\t있음\n둘째' };
    expect(load(toSortedYaml(v))).toEqual(v);
  });

  it('배열 안의 객체와 배열', () => {
    const v = { l: [{ b: 1, a: 'x' }, [1, 2], 'z'] };
    expect(load(toSortedYaml(v))).toEqual(v);
  });

  it('공개 API 명세 전체가 그대로 돌아오고, 두 번 만들어도 같다', () => {
    const spec = buildOpenApi(V1_OPERATIONS, V1_OPENAPI_INFO);
    const y = toSortedYaml(spec);
    expect(load(y)).toEqual(JSON.parse(JSON.stringify(spec)));
    expect(toSortedYaml(buildOpenApi(V1_OPERATIONS, V1_OPENAPI_INFO))).toBe(y);
  });
});
