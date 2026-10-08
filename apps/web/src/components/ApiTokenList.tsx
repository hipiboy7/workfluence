import type { ApiTokenView } from '@workfluence/shared';

export const API_SCOPE_NAMES = {} as Record<string, string>;
export function ApiTokenList(_p: { tokens: ApiTokenView[]; onRevoke: (t: ApiTokenView) => void; busyId?: string | null; emptyText?: string }) {
  return null;
}
