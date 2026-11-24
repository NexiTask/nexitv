import { useNavigate } from 'react-router-dom';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { CatalogPageHeader } from '@/modules/catalog/public/components/CatalogPageHeader';
import { MediaCard } from '@/modules/catalog/public/components/MediaCard';
import { parseMediaDisplayTitle } from '@/modules/catalog/public/lib/titleParser';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import { useTmdbDetailEnrichment } from '@/modules/metadata/public/hooks/useTmdbDetailsEnrichment';
import { desktopApi } from '@/platform/desktop';
import { tauriApi, type SeriesRecommendationKind } from '@/platform/tauri';
import { useI18n } from '@/shared/i18n/i18n';
import { getErrorMessage } from '@/shared/lib/error';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import type { HistoryItem } from '../store/useLibraryStore';
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

function Teaser({ item }: { item: MediaItem }) {
  const { t, date } = useI18n();
  const parsed = parseMediaDisplayTitle(item.title, item.year);
  const { details } = useTmdbDetailEnrichment('tv', {
    title: parsed?.cleanTitle ?? item.title,
    year: parsed.releaseYear ? Number(parsed.releaseYear) : null,
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
        onClick={(event) => {
          event.stopPropagation();
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
  onOpen: (item: MediaItem) => void;
}) {
  const { t, date } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const desktop = desktopApi.isDesktop();
  const { accounts, activeId, permission, snapshot, catalogue, data, cards } =
    useSeriesRecommendations(next, true, true);
  const { createRequest, matchingGenres, hasCandidates } = data;
  const generate = useMutation({
    mutationKey: generateKey,
    mutationFn: (clientId: string) => tauriApi.recommendationsGenerate(clientId, createRequest()),
    onSuccess: (result, clientId) =>
      queryClient.setQueryData(seriesRecommendationQueryKey(clientId), result),
    onError: () => void queryClient.invalidateQueries({ queryKey: chatGptAccountQueryKey }),
  });
  const generating = useIsMutating({ mutationKey: generateKey }) > 0;
  const canGenerate = Boolean(
    permission && !generating && !snapshot.isFetching && !catalogue.isLoading && hasCandidates,
  );
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

  return (
    <>
      <CatalogPageHeader
        title="Smart Recommendations"
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
            'Generating shares watched and saved series titles and catalogue metadata with OpenAI and uses your ChatGPT plan.',
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
            {results.map(({ key, item, kind, reason }) => (
              <li key={key}>
                <MediaCard
                  item={item}
                  onClick={onOpen}
                  posterDetails={{
                    description: (
                      <>
                        {reason && <p>{reason}</p>}
                        <p>{t(labels[kind])}</p>
                      </>
                    ),
                    action: kind === 'new' ? <Teaser item={item} /> : undefined,
                  }}
                />
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
