import type { ContactInfoView } from '@workfluence/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api';

/** 담당자 확인: 관리자가 편집한 안내문 + admin 이름 목록 (email 미노출) */
export function ContactPage() {
  const [info, setInfo] = useState<ContactInfoView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ContactInfoView>('/api/auth/contact').then(setInfo).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>담당자 확인</h1>
        {error && <p className="error">{error}</p>}
        {info && (
          <>
            <p className="notice info">{info.message}</p>
            <h2>관리자</h2>
            {info.admins.length ? (
              <ul className="plain">
                {info.admins.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">등록된 관리자가 없다.</p>
            )}
          </>
        )}
        <Link to="/login">← 로그인 화면</Link>
      </div>
    </div>
  );
}
