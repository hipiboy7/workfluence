import type { Request } from 'express';

/**
 * 유스케이스가 요청에서 받는 것 — 감사에 남길 IP뿐이다 (docs/spinoff/public-api 계획서 7.1절). 유스케이스는 express를 모른다:
 * 화면용 경로와 공개 API가 같은 유스케이스를 부르고, 시험은 요청 없이 부른다
 */
export type RequestMeta = { ip: string | null };

export const metaOf = (req: Request): RequestMeta => ({ ip: req.ip ?? null });
