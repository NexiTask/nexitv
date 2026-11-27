import { useNavigate } from 'react-router-dom';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { CatalogPageHeader } from '@/modules/catalog/public/components/CatalogPageHeader';
import { MediaCard } from '@/modules/catalog/public/components/MediaCard';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import { desktopApi } from '@/platform/desktop';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { tauriApi, type SeriesRecommendationKind } from '@/platform/tauri';
import { useI18n } from '@/shared/i18n/i18n';
import { getErrorMessage } from '@/shared/lib/error';
import { trackDataActivity } from '@/shared/lib/dataActivity';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { GridSkeleton } from '@/shared/ui/Skeleton';
import { RecommendationTrailers } from '../components/RecommendationTrailers';
import type { HistoryItem } from '../store/useLibraryStore';
import { useAutomatedRecommendations } from '../data/useAutomatedRecommendations';
import { mixSeriesRecommendations } from '../data/seriesRecommendations';
import {
  chatGptAccountQueryKey,
  seriesRecommendationQueryKey,
  useSeriesRecommendations,
} from '../data/useSeriesRecommendations';
import styles from './RecommendationsList.module.css';

const generateKey = ['chatgpt', 'series-recommendations-generate'] as const;
const labels: Record<SeriesRecommendationKind, string> = {
  discover: 'Discover a series',
  new: 'Recent in your catalogue',
};

export function RecommendationsList({
  next,
  onOpen,
  suspended,
}: {
  next: HistoryItem[];
  onOpen: (item: MediaItem) => void;
  suspended?: boolean | undefined;
}) {
  const { t, date } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const desktop = desktopApi.isDesktop();
  const smartEnabled = useSettingsStore((state) => state.recommendationsEnabled);
  const automated = useAutomatedRecommendations(next, true);
  const {
    accounts,
    activeId,
    permission,
    snapshot,
    catalogue,
    data,
    cards,
    isLoading,
    canPrepare,
    buildRequest,
  } = useSeriesRecommendations(next, smartEnabled, true);
  const { matchingGenres } = data;
  const generate = useMutation({
    mutationKey: generateKey,
    mutationFn: (clientId: string) =>
      trackDataActivity(
        'recommendations',
        async (_progress, reportDetail) => {
          const request = await buildRequest();
          return tauriApi.recommendationsGenerate(clientId, request, (stage) =>
            reportDetail({ phase: 'generate-recommendations', stage }),
          );
        },
        { phase: 'generate-recommendations', stage: 'preparing' },
      ),
    onSuccess: (result, clientId) =>
      queryClient.setQueryData(seriesRecommendationQueryKey(clientId), result),
    onError: () => void queryClient.invalidateQueries({ queryKey: chatGptAccountQueryKey }),
  });
  const generating = useIsMutating({ mutationKey: generateKey }) > 0;
  const canGenerate = Boolean(permission && !generating && !snapshot.isFetching && canPrepare);
  const results = cards.map((card) => {
    const match = card.genreMatch ? matchingGenres(card.item) : undefined;
    const reason = match?.genres.length
      ? t(
          match.watched
            ? 'Matches what you watch in {genres}'
            : 'Matches your favorites in {genres}',
          {
            genres: match.genres.map((genre) => t(genre)).join(', '),
          },
        )
      : undefined;
    return { ...card, reason: card.reason ?? reason };
  });
  const recommendations = mixSeriesRecommendations(results, automated);
  const showInitialLoading =
    smartEnabled && recommendations.length === 0 && (isLoading || generating);

  return (
    <>
      <CatalogPageHeader
        title="Recommendations"
        meta={
          smartEnabled && snapshot.data
            ? t('Last generated {date}', {
                date: date(snapshot.data.generatedAt * 1000, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })
            : t('TV series')
        }
        actions={
          smartEnabled && (
            <>
              {desktop && accounts.isSuccess && !permission && (
                <Button onClick={() => void navigate('/settings?section=general')}>
                  Connect ChatGPT
                </Button>
              )}
              <Button
                variant="primary"
                disabled={!canGenerate}
                onClick={() => activeId && generate.mutate(activeId)}
              >
                {generating ? (
                  <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
                ) : (
                  <Sparkles size={16} aria-hidden="true" />
                )}
                <span>
                  {generating
                    ? t('Generating…')
                    : snapshot.data
                      ? t('Refresh recommendations')
                      : t('Get recommendations')}
                </span>
              </Button>
            </>
          )
        }
      />
      <div className={styles.content} aria-busy={isLoading || generating}>
        {smartEnabled && (
          <p className={styles.notice}>
            {t(
              'Generating shares watched and saved series titles and catalogue metadata with OpenAI and uses your ChatGPT plan.',
            )}
          </p>
        )}
        {smartEnabled &&
          (generate.isError || snapshot.isError || accounts.isError || catalogue.isError) && (
            <p role="alert" className={styles.notice}>
              {getErrorMessage(
                generate.error ?? snapshot.error ?? accounts.error ?? catalogue.error,
                t('Could not load recommendations.'),
              )}
            </p>
          )}
        {smartEnabled && generating && recommendations.length > 0 && (
          <div className={styles.loadingBanner} aria-live="polite">
            <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
            <span>{t('Refreshing recommendations in the background…')}</span>
          </div>
        )}
        {recommendations.length > 0 ? (
          <RecommendationTrailers
            items={recommendations.map(({ card }) => card.item)}
            onOpen={onOpen}
            suspended={suspended}
          >
            {(preview, selectedId, select) => (
              <>
                {preview}
                <ul className={styles.results}>
                  {recommendations.map(({ source, card }) => (
                    <li key={card.item.id}>
                      <MediaCard
                        item={card.item}
                        onClick={select}
                        onViewDetails={onOpen}
                        previewSelected={selectedId === card.item.id}
                        posterDetails={{
                          source,
                          description:
                            source === 'chatgpt' ? (
                              <>
                                {card.reason && <p>{card.reason}</p>}
                                <p>{t(labels[card.kind])}</p>
                              </>
                            ) : undefined,
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </RecommendationTrailers>
        ) : showInitialLoading ? (
          <div className={styles.loadingSection} aria-live="polite">
            <div className={styles.loadingBanner}>
              <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" />
              <span>
                {generating ? t('Finding series for you…') : t('Loading recommendations…')}
              </span>
            </div>
            <GridSkeleton count={8} />
          </div>
        ) : (
          <EmptyState
            icon={Sparkles}
            title="No recommendations to show"
            description={
              !smartEnabled
                ? 'Save a series to your library to see it here before you start watching.'
                : snapshot.data
                  ? 'Refresh to get picks from your current sources and viewing activity.'
                  : 'Generate recommendations from your favorites, viewing activity, and available series.'
            }
          />
        )}
      </div>
    </>
  );
}
