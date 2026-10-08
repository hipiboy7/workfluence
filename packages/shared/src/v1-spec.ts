import type { z } from 'zod';

export type V1Op = {
  id: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  tag: string;
  summary: string;
  description?: string;
  admin?: boolean;
  public?: boolean;
  params?: Record<string, { kind: 'uuid' | 'integer' | 'string'; description: string }>;
  query?: z.ZodType;
  body?: z.ZodType;
  multipart?: z.ZodType;
  response: z.ZodType | { contentType: string; description: string };
};

export const V1_OPERATIONS: V1Op[] = [];

export function buildOpenApi(_ops: readonly V1Op[], _info: { title: string; version: string; description: string }): object {
  throw new Error('not implemented');
}
