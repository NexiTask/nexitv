import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Play, X } from 'lucide-react';
import type { HistoryItem } from '@/modules/library/public/store/useLibraryStore';
import { useTmdbDetailEnrichment } from '@/modules/metadata/public/hooks/useTmdbDetailsEnrichment';
import { normalizeTmdbId } from '@/modules/metadata/public/model/tmdb';
import { useI18n } from '@/shared/i18n/i18n';
import { Button, IconButton } from '@/shared/ui/Button';
import { useSeriesInfo } from '../data/useDetails';
import { quickPlay } from '../lib/quickPlay';
import { parseMediaDisplayTitle } from '../lib/titleParser';
import type { MediaItem } from '../model/media';
import styles from './WatchNextFeature.module.css';

interface WatchNextFeatureProps {
  items: HistoryItem[];
  onOpen: (item: MediaItem) => void;
  onDismiss: (item: MediaItem) => void;
  onSeeAll: () => void;
}

export function WatchNextFeature({ items, onOpen, onDismiss, onSeeAll }: WatchNextFeatureProps) {
  const { t, number } = useI18n();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [selectedId, setSelectedId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
  const item = items[index];
  if (!item) return null;

  const { cleanTitle } = parseMediaDisplayTitle(item.seriesTitle || item.title, item.year);
  const title = cleanTitle || item.seriesTitle || item.title;
  const episodeCode =
    item.seasonNum != null && item.episodeNum != null
      ? `S${item.seasonNum} E${item.episodeNum}`
      : '';
  const episodeLabel = [episodeCode, item.episodeTitle].filter(Boolean).join(' · ');

  const play = async () => {
    setStarting(true);
    try {
      if (!(await quickPlay(queryClient, item))) onOpen(item);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className={styles.feature} aria-labelledby={headingId}>
      <EpisodeArtwork key={item.id} item={item} title={title} />
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.content}>
        <div className={styles.headingRow}>
          <h2 className={styles.heading} id={headingId}>
            {t('Watch Next')}
          </h2>
          <Button
            className={styles.quiet}
            variant="ghost"
            size="sm"
            onClick={onSeeAll}
            aria-label={t('See all for Watch Next')}
          >
            See all
          </Button>
        </div>
        <div className={styles.episode} aria-live="polite">
          <h3 className={styles.title}>{title}</h3>
          {episodeLabel && <p className={styles.label}>{episodeLabel}</p>}
        </div>
        <div className={styles.actions}>
          <Button
            className={styles.play}
            variant="primary"
            disabled={starting}
            onClick={() => void play()}
          >
            <Play size={18} fill="currentColor" aria-hidden="true" />
            {t('Play episode')}
          </Button>
          <Button className={styles.quiet} variant="ghost" onClick={() => onOpen(item)}>
            Series details
          </Button>
        </div>
      </div>
      {items.length > 1 && (
        <div className={styles.controls} role="group" aria-label={t('Watch Next navigation')}>
          <IconButton
            className={styles.arrow}
            aria-label={t('Previous episode')}
            disabled={starting || index === 0}
            onClick={() => setSelectedId(items[index - 1]?.id)}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </IconButton>
          <IconButton
            className={styles.arrow}
            aria-label={t('Next episode')}
            disabled={starting || index === items.length - 1}
            onClick={() => setSelectedId(items[index + 1]?.id)}
          >
            <ChevronRight size={22} aria-hidden="true" />
          </IconButton>
        </div>
      )}
      <div className={styles.footer}>
        {items.length > 1 && (
          <span>
            {number(index + 1)} / {number(items.length)}
          </span>
        )}
        <IconButton
          className={styles.quiet}
          size="sm"
          aria-label={t('Remove from Watch Next')}
          title={t('Remove from Watch Next')}
          disabled={starting}
          onClick={() => {
            setSelectedId((items[index + 1] ?? items[index - 1])?.id);
            onDismiss(item);
          }}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </section>
  );
}

function EpisodeArtwork({ item, title }: { item: HistoryItem; title: string }) {
  const [failedBackdrop, setFailedBackdrop] = useState<string>();
  const [failedPoster, setFailedPoster] = useState<string>();
  const { data, isLoading } = useSeriesInfo(
    item.seriesSourceItemId || item.sourceItemId || item.id,
    item.sourceId,
  );
  const lookup = parseMediaDisplayTitle(
    data?.info?.name || title,
    data?.info?.releaseDate || item.year,
  );
  const { details } = useTmdbDetailEnrichment('tv', {
    title: lookup.cleanTitle || title,
    year: lookup.releaseYear ? Number(lookup.releaseYear) : null,
    tmdbId: normalizeTmdbId(data?.info?.tmdb ?? data?.info?.tmdb_id),
    ready: !isLoading,
  });
  const backdrop = details?.backdropUrl || data?.info?.backdrop_path?.[0];
  const poster = details?.posterUrl || item.seriesPosterUrl || data?.info?.cover || item.posterUrl;
  if (backdrop && backdrop !== failedBackdrop) {
    return (
      <img
        className={styles.backdrop}
        src={backdrop}
        alt=""
        onError={() => setFailedBackdrop(backdrop)}
      />
    );
  }
  if (!poster || poster === failedPoster) return null;
  return (
    <img className={styles.poster} src={poster} alt="" onError={() => setFailedPoster(poster)} />
  );
}
