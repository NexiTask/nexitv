import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import type { HistoryItem } from '@/modules/library/public/store/useLibraryStore';
import { useTmdbDetailEnrichment } from '@/modules/metadata/public/hooks/useTmdbDetailsEnrichment';
import { normalizeTmdbId } from '@/modules/metadata/public/model/tmdb';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { useI18n } from '@/shared/i18n/i18n';
import { Button, IconButton } from '@/shared/ui/Button';
import { useSeriesInfo } from '../data/useDetails';
import { quickPlay } from '../lib/quickPlay';
import { parseMediaDisplayTitle } from '../lib/titleParser';
import type { MediaItem } from '../model/media';
import styles from './WatchNextFeature.module.css';

const ROTATION_INTERVAL_MS = 12_000;

interface WatchNextFeatureProps {
  items: HistoryItem[];
  suspended?: boolean | undefined;
  onOpen: (item: MediaItem) => void;
  onDismiss: (item: MediaItem) => void;
  onSeeAll: () => void;
}

export function WatchNextFeature({
  items,
  suspended,
  onOpen,
  onDismiss,
  onSeeAll,
}: WatchNextFeatureProps) {
  const { t, number } = useI18n();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [selectedId, setSelectedId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [rotationChoice, setRotationChoice] = useState<boolean>();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const feature = useRef<HTMLElement>(null);
  const systemReducedMotion = useReducedMotion();
  const motion = useSettingsStore((state) => state.motionPreference);
  const reducedMotion = motion === 'reduced' || (motion === 'system' && systemReducedMotion);
  const rotationEnabled = rotationChoice ?? !reducedMotion;
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
  const item = items[index];
  const hasItem = Boolean(item);
  const nextId = (items[index + 1] ?? items[0])?.id;
  const rotating = Boolean(
    items.length > 1 &&
    rotationEnabled &&
    inView &&
    pageVisible &&
    !suspended &&
    !starting &&
    !hovered &&
    !focused,
  );

  useEffect(() => {
    const node = feature.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5)),
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasItem]);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!rotating || !nextId) return;
    const timer = window.setTimeout(() => setSelectedId(nextId), ROTATION_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [rotating, item?.id, nextId]);

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
    <>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} id={headingId}>
          {t('Watch Next')}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSeeAll}
          aria-label={t('See all for Watch Next')}
        >
          {t('See all')}
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
      <section
        ref={feature}
        className={styles.feature}
        aria-labelledby={headingId}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <EpisodeArtwork key={item.id} item={item} title={title} />
        <div className={styles.scrim} aria-hidden="true" />
        <div className={styles.content}>
          <div className={styles.episode} aria-live={rotationEnabled ? 'off' : 'polite'}>
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
            <>
              <span>
                {number(index + 1)} / {number(items.length)}
              </span>
              <IconButton
                className={styles.quiet}
                size="sm"
                aria-label={t(
                  rotationEnabled ? 'Pause Watch Next rotation' : 'Start Watch Next rotation',
                )}
                onClick={() => setRotationChoice(!rotationEnabled)}
              >
                {rotationEnabled ? (
                  <Pause size={16} aria-hidden="true" />
                ) : (
                  <Play size={16} aria-hidden="true" />
                )}
              </IconButton>
            </>
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
        {rotating && !reducedMotion && (
          <div
            key={item.id}
            className={styles.rotationProgress}
            style={{ animationDuration: `${ROTATION_INTERVAL_MS}ms` }}
            aria-hidden="true"
          />
        )}
      </section>
    </>
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
