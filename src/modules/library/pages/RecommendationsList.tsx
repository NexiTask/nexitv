import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { CatalogPageHeader } from '@/modules/catalog/public/components/CatalogPageHeader';
import { useCategories, useVisibleCatalog } from '@/modules/catalog/public/data/useCategories';
import { getDisplayTitle, parseMediaDisplayTitle } from '@/modules/catalog/public/lib/titleParser';
import type { MediaItem, MediaOpenContext } from '@/modules/catalog/public/model/media';
import { useUpcomingReleases } from '@/modules/guide/public/data/useUpcomingReleases';
import { useTmdbDetailEnrichment } from '@/modules/metadata/public/hooks/useTmdbDetailsEnrichment';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { desktopApi } from '@/platform/desktop';
import { canThumbPoster, posterThumbUrl } from '@/platform/posterThumb';
import { tauriApi, type SeriesRecommendationKind } from '@/platform/tauri';
import { useI18n } from '@/shared/i18n/i18n';
import { getErrorMessage } from '@/shared/lib/error';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { collectSeriesRecommendations } from '../data/seriesRecommendations';
import { useLibraryStore, type HistoryItem } from '../store/useLibraryStore';
import styles from './RecommendationsList.module.css';

const accountKey = ['chatgpt', 'accounts'] as const;
const generateKey = ['chatgpt', 'series-recommendations-generate'] as const;
const labels: Record<SeriesRecommendationKind, string> = {
  resume: 'Continue watching',
  next: 'Next episode',
  discover: 'Discover a series',
  new: 'Recent in your catalogue',
  upcoming: 'Upcoming episode',
};

function Teaser({ item, tmdbId }: { item: MediaItem; tmdbId?: number | undefined }) {
  const { t, date } = useI18n();
  const parsed = parseMediaDisplayTitle(item.title, item.year);
  const { details } = useTmdbDetailEnrichment('tv', {
    title: parsed?.cleanTitle ?? item.title,
    year: parsed.releaseYear ? Number(parsed.releaseYear) : null,
    tmdbId,
  });
  const video = details?.videos
    .filter(({ type, official }) => official && /^(teaser|trailer)$/i.test(type ?? ''))
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0];
  if (!video) return null;
  const published = video.publishedAt ? new Date(video.publishedAt) : null;
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          void desktopApi.openUrl(video.url).catch(() => {});
        }}
      >
        {video.type?.toLowerCase() === 'teaser'
          ? t('Watch series teaser')
          : t('Watch series trailer')}
      </Button>
      {published && !Number.isNaN(published.valueOf()) && <small>{date(published)}</small>}
    </>
  );
}

export function RecommendationsList({
  next,
  onOpen,
}: {
  next: HistoryItem[];
  onOpen: (item: MediaItem, context?: MediaOpenContext) => void;
}) {
  const { t, date } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const desktop = desktopApi.isDesktop();
  const favorites = useLibraryStore((state) => state.favorites);
  const history = useLibraryStore((state) => state.history);
  const trackedSeries = useLibraryStore((state) => state.trackedSeries);
  const started = useLibraryStore((state) => state.startedSeries);
  const hideAdult = useSettingsStore((state) => state.catalogHideAdult);
  const catalogue = useVisibleCatalog('series');
  const categoryList = useCategories('series');
  const favoriteIds = useMemo(
    () => favorites.filter(({ type }) => type === 'series').map(({ id }) => id),
    [favorites],
  );
  const upcoming = useUpcomingReleases({ favoriteIds });
  const today = new Date().toLocaleDateString('sv-SE');

  const { groupPicks, createRequest, matchingGenres, hasCandidates } = useMemo(
    () =>
      collectSeriesRecommendations({
        catalogue: catalogue.data.filter((item) => !hideAdult || !item.adult),
        favorites,
        history,
        trackedSeries,
        started,
        next,
        upcoming: upcoming.data ?? [],
        categories: new Map(
          categoryList.data?.map(({ category_id, category_name }) => [category_id, category_name]),
        ),
        today,
      }),
    [
      catalogue.data,
      hideAdult,
      favorites,
      history,
      trackedSeries,
      started,
      next,
      upcoming.data,
      categoryList.data,
      today,
    ],
  );

  const accounts = useQuery({
    queryKey: accountKey,
    queryFn: tauriApi.chatGptStatus,
    enabled: desktop,
    retry: false,
  });
  const activeId = accounts.data?.activeClient ?? null;
  const permission = accounts.data?.accounts.some(
    ({ clientId, planPermission }) => clientId === activeId && planPermission,
  );
  const cacheKey = ['chatgpt', 'series-recommendations', activeId] as const;
  const snapshot = useQuery({
    queryKey: cacheKey,
    queryFn: () => tauriApi.recommendationsCached(activeId!),
    enabled: desktop && activeId !== null,
    retry: false,
  });
  const generate = useMutation({
    mutationKey: generateKey,
    mutationFn: (clientId: string) => tauriApi.recommendationsGenerate(clientId, createRequest()),
    onSuccess: (result, clientId) =>
      queryClient.setQueryData(['chatgpt', 'series-recommendations', clientId], result),
    onError: () => void queryClient.invalidateQueries({ queryKey: accountKey }),
  });
  const generating = useIsMutating({ mutationKey: generateKey }) > 0;
  const canGenerate = Boolean(
    permission && !generating && !snapshot.isFetching && !catalogue.isLoading && hasCandidates,
  );
  const results = groupPicks(snapshot.data?.picks ?? []).map((card) => {
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
    return { ...card, reason };
  });

  return (
    <>
      <CatalogPageHeader
        title="Recommendations"
        meta={
          snapshot.data
            ? t('Last generated {date}', {
                date: date(snapshot.data.generatedAt * 1000, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })
            : t('TV series')
        }
        actions={
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
              <Sparkles size={16} aria-hidden="true" />
              <span>
                {generating
                  ? t('Generating…')
                  : snapshot.data
                    ? t('Refresh recommendations')
                    : t('Get recommendations')}
              </span>
            </Button>
          </>
        }
      />
      <div className={styles.content}>
        <p className={styles.notice}>
          {t(
            'Generating shares a genre summary and a shortlist of series and episode types with OpenAI and uses your ChatGPT plan.',
          )}
        </p>
        {(generate.isError || snapshot.isError || accounts.isError || catalogue.isError) && (
          <p role="alert" className={styles.notice}>
            {getErrorMessage(
              generate.error ?? snapshot.error ?? accounts.error ?? catalogue.error,
              t('Could not load recommendations.'),
            )}
          </p>
        )}
        {results.length > 0 ? (
          <ul className={styles.results}>
            {results.map(({ key, item, signals, reason }) => (
              <li className={styles.card} key={key}>
                {item.posterUrl && (
                  <img
                    src={
                      canThumbPoster(item.posterUrl)
                        ? posterThumbUrl(item.posterUrl)
                        : item.posterUrl
                    }
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                )}
                <div className={styles.details}>
                  <h2>{getDisplayTitle(item.title, 'series')}</h2>
                  {signals.map(({ kind, item: signalItem, release }) => (
                    <p key={kind}>
                      {t(labels[kind])}
                      {release ? (
                        <>
                          {' '}
                          · {release.title} ·{' '}
                          <time dateTime={release.airDate}>
                            {date(new Date(`${release.airDate}T12:00:00`))}
                          </time>
                        </>
                      ) : signalItem.episodeTitle ? (
                        <> · {signalItem.episodeTitle}</>
                      ) : null}
                    </p>
                  ))}
                  {reason && <p>{reason}</p>}
                  <div className={styles.actions}>
                    <Button
                      size="sm"
                      onClick={() => {
                        const release = signals[0]?.release;
                        onOpen(
                          item,
                          release
                            ? {
                                seasonNumber: release.seasonNumber ?? undefined,
                                episodeNumber: release.episodeNumber ?? undefined,
                              }
                            : undefined,
                        );
                      }}
                    >
                      {t('Open series')}
                    </Button>
                    {signals.some(({ kind }) => kind === 'upcoming' || kind === 'new') && (
                      <Teaser
                        item={item}
                        tmdbId={signals.find(({ release }) => release)?.release?.tmdbId}
                      />
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={Sparkles}
            title={generating ? 'Finding series for you' : 'No recommendations to show'}
            description={
              snapshot.isFetching || catalogue.isLoading
                ? 'Loading series and saved recommendations…'
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
