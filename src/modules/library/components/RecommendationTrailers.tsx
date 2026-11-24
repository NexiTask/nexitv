import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import { parseMediaDisplayTitle } from '@/modules/catalog/public/lib/titleParser';
import type { MediaItem } from '@/modules/catalog/public/model/media';
import { useTmdbDetailEnrichment } from '@/modules/metadata/public/hooks/useTmdbDetailsEnrichment';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { desktopApi } from '@/platform/desktop';
import { tauriApi } from '@/platform/tauri';
import { useI18n } from '@/shared/i18n/i18n';
import { Button } from '@/shared/ui/Button';
import styles from './RecommendationTrailers.module.css';

const YOUTUBE_EMBED = 'https://www.youtube-nocookie.com/embed/';
const VISIBLE_THRESHOLD = 0.51;

interface RecommendationTrailersProps {
  items: MediaItem[];
  onOpen: (item: MediaItem) => void;
  suspended?: boolean | undefined;
  fullWidth?: boolean | undefined;
  children: (
    preview: ReactNode,
    selectedId: string,
    select: (item: MediaItem) => void,
  ) => ReactNode;
}

export function RecommendationTrailers({
  items,
  onOpen,
  suspended,
  fullWidth,
  children,
}: RecommendationTrailersProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const [autoplayChoice, setAutoplayChoice] = useState<boolean>();
  const motionPreference = useSettingsStore((state) => state.motionPreference);
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const onChange = () => setSystemReducedMotion(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const autoplay =
    autoplayChoice ??
    (motionPreference === 'full' || (motionPreference === 'system' && !systemReducedMotion));
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  if (!selected) return null;

  return children(
    <TrailerFeature
      key={selected.id}
      item={selected}
      autoplay={autoplay}
      suspended={suspended}
      fullWidth={fullWidth}
      onAutoplayChange={setAutoplayChoice}
      onOpen={onOpen}
    />,
    selected.id,
    (item) => setSelectedId(item.id),
  );
}

function TrailerFeature({
  item,
  autoplay,
  suspended,
  fullWidth,
  onAutoplayChange,
  onOpen,
}: {
  item: MediaItem;
  autoplay: boolean;
  suspended?: boolean | undefined;
  fullWidth?: boolean | undefined;
  onAutoplayChange: (enabled: boolean) => void;
  onOpen: (item: MediaItem) => void;
}) {
  const { t } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const [mode, setMode] = useState<'auto' | 'manual' | 'closed'>('auto');
  const [endpoint, setEndpoint] = useState<string>();
  const [embedFailed, setEmbedFailed] = useState(false);
  const desktop = desktopApi.isDesktop();
  const { cleanTitle, releaseYear } = parseMediaDisplayTitle(item.title, item.year);
  const title = cleanTitle || item.title;
  const { details, rating } = useTmdbDetailEnrichment('tv', {
    title,
    year: releaseYear ? Number(releaseYear) : null,
  });
  const videos = details?.videos
    .filter(({ type, official }) => official && /^(teaser|trailer)$/i.test(type ?? ''))
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const youtube = videos?.find(({ site, url }) => site === 'YouTube' && youtubeVideoId(url));
  const trailer = youtube ?? videos?.[0];
  const videoId = youtube && youtubeVideoId(youtube.url);
  const isTeaser = trailer?.type?.toLowerCase() === 'teaser';
  const playLabel = isTeaser ? 'Watch teaser' : 'Watch trailer';

  useEffect(() => {
    const element = stage.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        setIsVisible(
          entry.isIntersecting &&
            entry.intersectionRatio >= VISIBLE_THRESHOLD &&
            entry.boundingClientRect.width >= 200 &&
            entry.boundingClientRect.height >= 200,
        );
      },
      { threshold: VISIBLE_THRESHOLD },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const canPlay =
    !suspended &&
    documentVisible &&
    (isVisible || (mode === 'manual' && typeof IntersectionObserver === 'undefined'));
  const wantsPlayback = Boolean(
    videoId && canPlay && (mode === 'manual' || (autoplay && mode === 'auto')),
  );
  useEffect(() => {
    if (!desktop || !wantsPlayback || endpoint || embedFailed) return;
    let active = true;
    void tauriApi.recommendationTrailerEndpoint().then(
      (url) => {
        if (active) setEndpoint(url);
      },
      () => {
        if (active) setEmbedFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [desktop, wantsPlayback, endpoint, embedFailed]);
  const embedUrl =
    videoId && wantsPlayback
      ? desktop
        ? endpoint && `${endpoint}${videoId}`
        : `${YOUTUBE_EMBED}${videoId}?autoplay=1&mute=1&playsinline=1&controls=0`
      : undefined;
  useEffect(() => {
    if (!desktop || !embedUrl) return;
    const origin = new URL(embedUrl).origin;
    const onPlayerMessage = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      if (!source || event.origin !== origin || event.source !== source) return;
      if (event.data === 'nexitv:trailer-blocked' && mode === 'auto') setMode('closed');
      if (event.data === 'nexitv:trailer-ended') setMode('closed');
      if (event.data === 'nexitv:trailer-error') setEmbedFailed(true);
    };
    window.addEventListener('message', onPlayerMessage);
    return () => window.removeEventListener('message', onPlayerMessage);
  }, [desktop, embedUrl, mode]);
  const playerUrl = embedFailed ? undefined : embedUrl;
  const art = details?.backdropUrl || details?.posterUrl || item.posterUrl;
  const summary = details?.overview || item.description;
  const year = details?.releaseYear ?? releaseYear;
  const metadata = [year, trailer && t(isTeaser ? 'Teaser' : 'Trailer')]
    .filter(Boolean)
    .join(' · ');
  const openExternally = () => {
    if (!trailer) return;
    setMode('closed');
    void desktopApi.openUrl(trailer.url).catch(() => {});
  };

  return (
    <section
      className={fullWidth ? `${styles.panel} ${styles.fullWidth}` : styles.panel}
      aria-label={t('Recommendation preview')}
    >
      <div className={styles.feature}>
        <div className={styles.details}>
          {fullWidth && details?.backdropUrl && (
            <img
              className={styles.detailsBackdrop}
              src={details.backdropUrl}
              alt=""
              loading="lazy"
            />
          )}
          <h3>{title}</h3>
          {metadata && <p className={styles.metadata}>{metadata}</p>}
          {summary && <p className={styles.summary}>{summary}</p>}
          {!trailer && rating.status !== 'pending' && (
            <p className={styles.status}>{t('No official trailer available')}</p>
          )}
          {embedFailed && <p className={styles.status}>{t('Inline playback is unavailable')}</p>}
          <div className={styles.actions}>
            {playerUrl ? (
              <Button size="sm" onClick={() => setMode('closed')}>
                Close trailer
              </Button>
            ) : videoId && !embedFailed ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setMode('manual');
                  stage.current?.scrollIntoView?.({ block: 'nearest' });
                }}
              >
                <Play size={14} aria-hidden="true" />
                {t(playLabel)}
              </Button>
            ) : trailer ? (
              <Button size="sm" onClick={openExternally}>
                Open trailer in browser
              </Button>
            ) : null}
            <Button size="sm" onClick={() => onOpen(item)}>
              Series details
            </Button>
          </div>
          <div className={styles.preferences}>
            <label className={styles.autoplay}>
              <input
                type="checkbox"
                checked={autoplay}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  if (enabled) setMode('auto');
                  onAutoplayChange(enabled);
                }}
              />
              {t('Autoplay trailers')}
            </label>
            {playerUrl && (
              <Button size="sm" variant="ghost" onClick={openExternally}>
                Open on YouTube
              </Button>
            )}
          </div>
        </div>
        <div className={styles.stage} ref={stage}>
          {playerUrl ? (
            <iframe
              ref={frame}
              title={t('Trailer for {title}', { title })}
              src={playerUrl}
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : (
            art && (
              <img
                key={art}
                src={art}
                alt=""
                loading="lazy"
                className={details?.backdropUrl ? styles.backdrop : styles.poster}
              />
            )
          )}
        </div>
      </div>
    </section>
  );
}

function youtubeVideoId(url: string): string | undefined {
  const id = new URL(url).searchParams.get('v');
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined;
}
