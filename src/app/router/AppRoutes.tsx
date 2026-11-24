import { Suspense } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { useI18n } from '@/shared/i18n/i18n';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PageTransition } from '../shell/PageTransition';
import styles from '../shell/AppLayout.module.css';
import {
  EpgPage,
  HomePage,
  LibraryPage,
  LiveTvPage,
  M3uEditorPage,
  MoviesPage,
  SearchPage,
  SeriesPage,
  SettingsPage,
} from './routeModules';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <PageTransition>
      <div className={styles.page}>
        <EmptyState
          icon={Compass}
          title="Page Not Found"
          description="That page is not part of this NexiTV workspace. Return to Home to keep browsing."
          actionLabel="Back to Home"
          onAction={() => void navigate('/')}
        />
      </div>
    </PageTransition>
  );
}

export function AppRoutes() {
  const { t } = useI18n();

  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className={styles.routeLoading} role="status" aria-label={t('Loading page')}>
            <span />
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/live" element={<LiveTvPage />} />
          <Route path="/epg" element={<EpgPage />} />
          <Route path="/movies" element={<MoviesPage />} />
          <Route path="/series" element={<SeriesPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/continue" element={<Navigate to="/library/continue" replace />} />
          <Route path="/watch-next" element={<Navigate to="/library/watch-next" replace />} />
          <Route path="/library/:listId?" element={<LibraryPage />} />
          <Route path="/favorites" element={<Navigate to="/library/favorites" replace />} />
          <Route path="/collections" element={<Navigate to="/library" replace />} />
          <Route path="/downloads" element={<Navigate to="/library/downloads" replace />} />
          <Route path="/upcoming" element={<Navigate to="/library/upcoming" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/m3u-editor/:sourceId?" element={<M3uEditorPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
