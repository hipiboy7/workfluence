import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * `--mode demo`는 **스마트폰 시연판**(F-015)이다 — 화면이 서버 대신 폰 안의 시연 저장소(`src/demo/`)에 묻는다(`src/api.ts`). 산출물은
 * `dist-demo`로 따로 나가 제품 산출물(`dist` — app 이미지가 싣는 것)과 섞이지 않는다. 그 밖의 모드는 지금까지와 같다
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      // 공유 패키지는 소스를 직접 번들한다 (api는 dist를 쓴다). 두 쪽이 같은 zod 스키마·상수를 공유한다.
      '@workfluence/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: mode === 'demo' ? 'dist-demo' : 'dist',
    sourcemap: false,
    emptyOutDir: true,
  },
}));
