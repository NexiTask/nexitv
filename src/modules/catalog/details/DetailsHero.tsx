import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useI18n } from '@/shared/i18n/i18n';
import { getTagColorType } from '@/shared/lib/mediaTags';
import styles from './DetailsHero.module.css';

interface DetailsHeroProps {
  titleId: string;
  title: string;
  posterUrl?: string | undefined;
  /** Shown in place of a missing or broken poster. */
  posterIcon: ReactNode;
  /** Landscape art; without it the poster, blurred, tints the hero. */
  backdropUrl?: string | undefined;
  /** Year, runtime, rating, seasons…: each one fact, laid out without
   * separators so a wrapped line never starts with a stray dot. */
  facts: ReactNode[];
  /** "Animation / Action" as the providers and TMDB give it. */
  genres?: string | undefined;
  /** Technical tags (4K, HDR…). */
  tags?: readonly string[] | undefined;
  plot: string;
  expanded: boolean;
  /** Present when there is more to show (a long plot, more cast). */
  onToggleExpanded?: (() => void) | undefined;
  /** The play/resume button and its companions. */
  actions: ReactNode;
  /** The version picker, when the title has several. */
  versions?: ReactNode;
}

/**
 * The top of a movie or series sheet: art across the full width, the poster
 * beside the title, what the title is, and what you can do with it. What
 * follows (episodes, credits) scrolls up underneath with the rest.
 */
export function DetailsHero({
  titleId,
  title,
  posterUrl,
  posterIcon,
  backdropUrl,
  facts,
  genres,
  tags = [],
  plot,
  expanded,
  onToggleExpanded,
  actions,
  versions,
}: DetailsHeroProps) {
  const { t } = useI18n();
  const [posterFailed, setPosterFailed] = useState(false);
  const showPoster = Boolean(posterUrl) && !posterFailed;
  const art = backdropUrl || (showPoster ? posterUrl : undefined);
  const genreList = (genres ?? '')
    .split(/\s*[/,]\s*/)
    .map((genre) => genre.trim())
    .filter(Boolean);

  return (
    <header className={styles.hero}>
      {art && (
        <div
          className={`${styles.art} ${backdropUrl ? '' : styles.artFromPoster}`}
          style={{ backgroundImage: `url(${JSON.stringify(art)})` }}
          aria-hidden="true"
        />
      )}
      <div className={styles.scrim} aria-hidden="true" />

      <div className={styles.inner}>
        <div className={styles.poster}>
          {showPoster ? (
            <img src={posterUrl} alt={title} onError={() => setPosterFailed(true)} />
          ) : (
            <div className={styles.posterPlaceholder}>
              {posterIcon}
              <span>{title}</span>
            </div>
          )}
        </div>

        <div className={styles.text}>
          <h1 id={titleId} className={styles.title}>
            {title}
          </h1>

          <div className={styles.facts}>
            {facts.filter(Boolean)}
            {tags.map((tag) => (
              <span key={tag} className={styles.tag} data-tag-type={getTagColorType(tag)}>
                {tag}
              </span>
            ))}
          </div>

          {genreList.length > 0 && (
            <div className={styles.genres}>
              {genreList.map((genre) => (
                <span key={genre} className={styles.genre}>
                  {genre}
                </span>
              ))}
            </div>
          )}

          <p className={`${styles.plot} ${expanded ? '' : styles.plotCollapsed}`}>{plot}</p>
          {onToggleExpanded && (
            <button
              type="button"
              className={styles.moreToggle}
              onClick={onToggleExpanded}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              {t(expanded ? 'Show less' : 'More details')}
            </button>
          )}

          <div className={styles.actions}>{actions}</div>
          {versions}
        </div>
      </div>
    </header>
  );
}
