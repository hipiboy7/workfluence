import { Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth } from './auth';
import { Layout } from './components/Layout';
import { AdminPage } from './pages/AdminPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { PageEditorPage } from './pages/PageEditorPage';
import { PageHistoryPage } from './pages/PageHistoryPage';
import { SearchPage } from './pages/SearchPage';
import { SpacePage } from './pages/SpacePage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/spaces/:spaceId" element={<SpacePage />} />
          <Route path="/spaces/:spaceId/pages/:pageId" element={<SpacePage />} />
          <Route path="/pages/:pageId/edit" element={<PageEditorPage />} />
          <Route path="/pages/:pageId/history" element={<PageHistoryPage />} />
          <Route path="/spaces/:spaceId/new" element={<PageEditorPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<p>페이지를 찾을 수 없다.</p>} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
