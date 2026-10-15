import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const start = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

// 스마트폰 시연판(F-015)만 폰 화면 맞춤을 먼저 싣는다 — 제품 빌드에서는 상수 거짓이라 실리지 않는다
if (import.meta.env.MODE === 'demo') void import('./demo/boot').then(start);
else start();
