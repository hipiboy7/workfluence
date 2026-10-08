import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { V1_DEFAULTS } from './v1';
import { buildOpenApi, V1_OPERATIONS, type V1Op } from './v1-spec';

/**
 * 공개 API v1의 OpenAPI 명세 (docs/spinoff/public-api 설계서 FR-2220·2221·2224). A등급 — 순수 함수다.
 * 명세는 **이미 있는 zod 스키마에서 만든다**(손으로 쓰지 않는다). 여기서는 만드는 규칙과 실제 경로 표의 불변식을 본다 — 경로 표가
 * 실제 컨트롤러와 같은지는 api의 계약 시험(`v1-openapi.contract.integration.spec.ts`)이 본다.
 */

const info = { title: 't', version: '1.0.0', description: 'd' };
const op = (over: Partial<V1Op>): V1Op => ({
  id: 'x.get',
  method: 'get',
  path: '/x/{id}',
  tag: 'x',
  summary: '요약',
  description: '설명',
  params: { id: { kind: 'uuid', description: '식별자' } },
  response: z.object({ ok: z.literal(true) }),
  ...over,
});
const doc = (ops: V1Op[]) => buildOpenApi(ops, info) as any;

describe('buildOpenApi — 한 경로', () => {
  it('OpenAPI 3.1, 서버는 /api/v1, 경로 칸은 필수이고 uuid 모양이다', () => {
    const d = doc([op({})]);
    expect(d.openapi).toBe('3.1.0');
    expect(d.servers).toEqual([{ url: '/api/v1' }]);
    const o = d.paths['/x/{id}'].get;
    expect(o).toMatchObject({ operationId: 'x.get', summary: '요약', description: '설명', tags: ['x'] });
    expect(o.parameters).toEqual([{ name: 'id', in: 'path', required: true, description: '식별자', schema: { type: 'string', format: 'uuid' } }]);
  });

  it('읽기는 scope read, 쓰기는 write, 관리 경로는 admin이 더 — 가드(requiredScopes)와 같다', () => {
    const d = doc([
      op({ id: 'a', path: '/a' , params: undefined }),
      op({ id: 'b', method: 'post', path: '/b', params: undefined }),
      op({ id: 'c', method: 'get', path: '/c', params: undefined, admin: true }),
      op({ id: 'd', method: 'patch', path: '/d', params: undefined, admin: true }),
    ]);
    expect(d.paths['/a'].get.security).toEqual([{ bearerAuth: ['read'] }]);
    expect(d.paths['/b'].post.security).toEqual([{ bearerAuth: ['write'] }]);
    expect(d.paths['/c'].get.security).toEqual([{ bearerAuth: ['admin', 'read'] }]);
    expect(d.paths['/d'].patch.security).toEqual([{ bearerAuth: ['admin', 'write'] }]);
    expect(d.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  });

  it('인증 없는 경로는 security가 빈 배열이다', () => {
    const d = doc([op({ id: 'p', path: '/openapi.json', params: undefined, public: true })]);
    expect(d.paths['/openapi.json'].get.security).toEqual([]);
    expect(d.paths['/openapi.json'].get.responses).not.toHaveProperty('401');
  });

  it('쿼리 스키마의 칸이 쿼리 매개변수가 된다 — 필수·기본값·범위를 그대로', () => {
    const q = z.strictObject({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(20) });
    const o = doc([op({ path: '/s', params: undefined, query: q })]).paths['/s'].get;
    const byName = Object.fromEntries(o.parameters.map((p: any) => [p.name, p]));
    expect(byName.q).toMatchObject({ in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } });
    expect(byName.limit).toMatchObject({ in: 'query', required: false, schema: { default: 20, minimum: 1, maximum: 50 } });
  });

  it('본문 스키마는 **입력 쪽**이다 — 변환(transform)이 있어도 받는 모양을 말한다', () => {
    const body = z.strictObject({ title: z.string(), format: z.enum(['markdown', 'json']).default('markdown') }).transform((v) => ({ t: v.title }));
    const o = doc([op({ method: 'post', path: '/p', params: undefined, body })]).paths['/p'].post;
    const s = o.requestBody.content['application/json'].schema;
    expect(o.requestBody.required).toBe(true);
    expect(s.properties.title).toEqual({ type: 'string' });
    expect(s.properties.format).toMatchObject({ enum: ['markdown', 'json'], default: 'markdown' });
    expect(s.required).toEqual(['title']);
    expect(JSON.stringify(s)).not.toContain('$schema');
  });

  it('응답은 200의 JSON 스키마(출력 쪽)이고 오류는 한 모양을 가리킨다', () => {
    const o = doc([op({})]).paths['/x/{id}'].get;
    expect(o.responses['200'].content['application/json'].schema.properties.ok).toMatchObject({ const: true });
    for (const code of ['400', '401', '403', '404', '429']) expect(o.responses[code].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Error' });
    expect(doc([op({})]).components.schemas.Error.properties.error.required).toEqual(['code', 'message', 'requestId']);
  });

  it('JSON이 아닌 응답(내보내기 HTML)은 그 형식으로 적는다', () => {
    const o = doc([op({ path: '/h', params: undefined, response: { contentType: 'text/html', description: 'HTML 한 파일' } })]).paths['/h'].get;
    expect(o.responses['200']).toEqual({ description: 'HTML 한 파일', content: { 'text/html': { schema: { type: 'string' } } } });
  });

  it('올리기(multipart)는 파일 칸을 이진으로 적는다', () => {
    const o = doc([op({ method: 'post', path: '/u', params: undefined, multipart: z.object({ filename: z.string().optional() }) })]).paths['/u'].post;
    const s = o.requestBody.content['multipart/form-data'].schema;
    expect(s.properties.file).toEqual({ type: 'string', format: 'binary' });
    expect(s.required).toContain('file');
  });

  it('경로의 {칸}과 params가 어긋나면 만들지 않는다', () => {
    expect(() => doc([op({ params: undefined })])).toThrow(/id/);
    expect(() => doc([op({ params: { id: { kind: 'uuid', description: 'a' }, extra: { kind: 'string', description: 'b' } } })])).toThrow(/extra/);
  });

  it('같은 경로·메서드나 같은 operationId가 둘이면 만들지 않는다', () => {
    expect(() => doc([op({ params: { id: { kind: 'uuid', description: '' } } }), op({ id: 'y' })])).toThrow(/x\/\{id\}/);
    expect(() => doc([op({}), op({ path: '/z/{id}' })])).toThrow(/x\.get/);
  });
});

describe('실제 경로 표(V1_OPERATIONS)의 불변식', () => {
  const d = buildOpenApi(V1_OPERATIONS, info) as any;
  const flat = V1_OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.path}`);

  it('모든 경로에 요약과 설명이 있다 — 에이전트는 이것으로 쓸 곳을 정한다', () => {
    expect(V1_OPERATIONS.length).toBeGreaterThanOrEqual(60);
    for (const o of V1_OPERATIONS) {
      expect(o.summary.length, o.id).toBeGreaterThan(3);
      expect((o.description ?? '').length, o.id).toBeGreaterThan(10);
    }
  });

  it('operationId는 `모듈.동작` 한 모양이다', () => {
    for (const o of V1_OPERATIONS) expect(o.id).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
  });

  it('**비밀번호 초기화와 LLM 경로가 없다**(FR-2209 · 사용자 결정 2026-10-08)', () => {
    expect(flat.filter((p) => /reset|llm/i.test(p))).toEqual([]);
  });

  it('관리 경로(사용자·정책·감사)만 admin 표시가 있다', () => {
    for (const o of V1_OPERATIONS) expect(!!o.admin, o.id).toBe(/^\/(users|settings|audit)/.test(o.path));
  });

  it('**기본값은 `V1_DEFAULTS` 한 곳에서 온다**(FR-2224) — 명세의 default가 그 상수와 같다', () => {
    const param = (opId: string, name: string) => d.paths[V1_OPERATIONS.find((o) => o.id === opId)!.path][V1_OPERATIONS.find((o) => o.id === opId)!.method].parameters.find((p: any) => p.name === name);
    expect(param('pages.get', 'format').schema.default).toBe(V1_DEFAULTS.readFormat);
    expect(param('search.find', 'limit').schema).toMatchObject({ default: V1_DEFAULTS.searchLimit, maximum: V1_DEFAULTS.searchLimitMax });
    const create = d.paths['/pages'].post.requestBody.content['application/json'].schema;
    expect(create.properties.format.default).toBe(V1_DEFAULTS.writeFormat);
    expect(create.required.sort()).toEqual(['body', 'space', 'title']); // 필수는 어디·제목·본문뿐(FR-2223)
    const member = d.paths['/spaces/{id}/members'].post.requestBody.content['application/json'].schema;
    expect(member.properties.role.default).toBe(V1_DEFAULTS.memberRole);
    const move = d.paths['/pages/{id}/move'].patch.requestBody.content['application/json'].schema;
    expect(move.properties.position.default).toBe(V1_DEFAULTS.moveToEnd);
  });

  it('**에이전트가 정하는 칸에는 설명이 있다** — 본문이 마크다운 글자인지 문서 객체인지, 스페이스를 이름으로 줘도 되는지를 명세가 말한다', () => {
    const create = d.paths['/pages'].post.requestBody.content['application/json'].schema.properties;
    for (const k of ['space', 'title', 'body']) expect(create[k].description, `pages.create ${k}`).toMatch(/\S{4}/);
    expect(create.body.description).toContain('마크다운');
    expect(create.space.description).toContain('이름');
    const update = d.paths['/pages/{id}'].patch.requestBody.content['application/json'].schema.properties;
    expect(update.baseVersionNo.description).toContain('기준');
    const search = d.paths['/search'].get.parameters;
    expect(search.find((p: any) => p.name === 'q').description).toMatch(/\S{4}/);
  });

  it('명세는 JSON으로 직렬화되고 외부 주소를 담지 않는다(폐쇄망)', () => {
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/https?:\/\/(?!json-schema\.org)/);
    expect(d.info.version).toBe('1.0.0');
  });

  it('모든 `$ref`가 문서 안의 실제 자리를 가리킨다', () => {
    const refs: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === '$ref' && typeof x === 'string') refs.push(x);
          else walk(x);
        }
      }
    };
    walk(d);
    expect(refs.length).toBeGreaterThan(100);
    for (const r of new Set(refs)) {
      const target = r.replace(/^#\//, '').split('/').reduce<any>((o, k) => o?.[k], d);
      expect(target, r).toBeTruthy();
    }
  });
});
