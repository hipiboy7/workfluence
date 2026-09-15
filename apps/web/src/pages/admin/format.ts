export const USER_STATUS_LABEL: Record<string, string> = { pending: '승인 대기', active: '활성', locked: '잠김' };
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('ko-KR');
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('ko-KR');
