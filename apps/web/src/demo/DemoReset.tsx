import { useConfirm } from '../components/ConfirmDialog';
import { resetDemo } from './server';

/**
 * **시연 데이터 처음으로** (F-015) — 시연 중 데이터가 꼬였을 때. 고친 것을 버리고 로그인 화면으로 돌아간다. 스페이스 목록이 시연 빌드에서만 그린다
 */
export default function DemoReset() {
  const [confirm, dialog] = useConfirm();
  return (
    <section className="demo-reset">
      {dialog}
      <p className="muted small">시연판 — 서버 없이 폰 안에서만 돕니다. 내용은 지어낸 시연 데이터입니다.</p>
      <button
        type="button"
        onClick={async () => {
          const ok = await confirm({ title: '시연 데이터를 처음으로 되돌릴까요?', body: '고친 문서·댓글·감사 기록이 모두 처음 상태로 돌아가고 로그인 화면으로 갑니다.', confirmLabel: '처음으로' });
          if (!ok) return;
          resetDemo();
          window.location.replace('/login');
        }}
      >
        시연 데이터 처음으로
      </button>
    </section>
  );
}
