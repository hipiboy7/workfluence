import type { SpaceView } from '@workfluence/shared';

export const KIND_LABEL = { personal: '개인', team: '팀' } as const;
export const STATUS_LABEL = { active: '활성', suspended: '중지' } as const;
export const MEMBER_ROLE_LABEL = { owner: '생성자', editor: '편집', viewer: '보기' } as const;

export function SpaceBadges({ space }: { space: SpaceView }) {
  return (
    <div className="badges">
      <span className={`badge kind-${space.kind}`}>{KIND_LABEL[space.kind]}</span>
      {space.categoryName && <span className="badge">{space.categoryName}</span>}
      <span className={`badge status-${space.status}`}>{STATUS_LABEL[space.status]}</span>
      {space.kind === 'team' && <span className="badge">Crew {space.memberCount}</span>}
    </div>
  );
}
