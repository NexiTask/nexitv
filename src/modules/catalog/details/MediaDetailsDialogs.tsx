import { lazy, Suspense, useRef, useState } from 'react';
import type { MediaItem } from '../model/media';
import { useTitleVariants } from '../data/useTitleVariants';

const MovieDetailsDialog = lazy(() =>
  import('./MovieDetailsDialog').then((module) => ({ default: module.MovieDetailsDialog })),
);
const SeriesDetailsDialog = lazy(() =>
  import('./SeriesDetailsDialog').then((module) => ({ default: module.SeriesDetailsDialog })),
);

function positiveNumber(value: string | number | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface MediaDetailsDialogsProps {
  selectedMovie?: MediaItem | null | undefined;
  selectedSeries?: MediaItem | null | undefined;
  onCloseMovie?: (() => void) | undefined;
  onCloseSeries?: (() => void) | undefined;
  onCloseAll?: (() => void) | undefined;
}

/** A grouped card stands for several provider variants; picking one re-keys
 * the open dialog onto it, until a different title is opened. */
interface TitleVariant {
  forId: string;
  item: MediaItem;
}

export function MediaDetailsDialogs({
  selectedMovie,
  selectedSeries,
  onCloseMovie,
  onCloseSeries,
  onCloseAll,
}: MediaDetailsDialogsProps) {
  const [movieVariant, setMovieVariant] = useState<TitleVariant | null>(null);
  const [seriesVariant, setSeriesVariant] = useState<TitleVariant | null>(null);
  const activeMovie =
    selectedMovie && movieVariant?.forId === selectedMovie.id ? movieVariant.item : selectedMovie;
  const activeSeries =
    selectedSeries && seriesVariant?.forId === selectedSeries.id
      ? seriesVariant.item
      : selectedSeries;

  // The list belongs to the clicked card, not to the copy on screen: picking
  // a version must not reshuffle the picker it was picked from.
  const movieVersions = useTitleVariants(
    selectedMovie?.type === 'vod' ? 'vod' : undefined,
    selectedMovie?.id,
  );
  const seriesVersions = useTitleVariants(
    selectedSeries?.type === 'series' ? 'series' : undefined,
    selectedSeries?.id,
  );

  // When one variant's provider call fails, the next untried one takes over
  // automatically; the picker stays on screen for the cases nothing answers.
  const advanceMovie = (failed: MediaItem, tried: Set<string>) => {
    tried.add(failed.id);
    const next = movieVersions.find((variant) => !tried.has(variant.item.id))?.item;
    if (next && selectedMovie) setMovieVariant({ forId: selectedMovie.id, item: next });
  };
  const advanceSeries = (failed: MediaItem, tried: Set<string>) => {
    tried.add(failed.id);
    const next = seriesVersions.find((variant) => !tried.has(variant.item.id))?.item;
    if (next && selectedSeries) setSeriesVariant({ forId: selectedSeries.id, item: next });
  };
  const movieFailures = useRef<{ forId: string; tried: Set<string> }>({
    forId: '',
    tried: new Set(),
  });
  const seriesFailures = useRef<{ forId: string; tried: Set<string> }>({
    forId: '',
    tried: new Set(),
  });
  if (selectedMovie && movieFailures.current.forId !== selectedMovie.id) {
    movieFailures.current = { forId: selectedMovie.id, tried: new Set() };
  }
  if (selectedSeries && seriesFailures.current.forId !== selectedSeries.id) {
    seriesFailures.current = { forId: selectedSeries.id, tried: new Set() };
  }
  const onMovieLoadFailed = () => {
    if (activeMovie) advanceMovie(activeMovie, movieFailures.current.tried);
  };
  const onSeriesLoadFailed = () => {
    if (activeSeries) advanceSeries(activeSeries, seriesFailures.current.tried);
  };

  const closeMovie = onCloseMovie || onCloseAll || (() => {});
  const closeSeries = onCloseSeries || onCloseAll || (() => {});

  const selectMovieVersion = (item: MediaItem) => {
    if (selectedMovie) setMovieVariant({ forId: selectedMovie.id, item });
  };
  const selectSeriesVersion = (item: MediaItem) => {
    if (selectedSeries) setSeriesVariant({ forId: selectedSeries.id, item });
  };

  return (
    <>
      {activeMovie && selectedMovie && (
        <Suspense fallback={null}>
          <MovieDetailsDialog
            key={activeMovie.id}
            movieId={activeMovie.id}
            movieTitle={activeMovie.title}
            moviePoster={activeMovie.posterUrl}
            sourceId={activeMovie.sourceId}
            sourceItemId={activeMovie.sourceItemId}
            versions={movieVersions}
            onSelectVersion={selectMovieVersion}
            onLoadFailed={onMovieLoadFailed}
            onClose={closeMovie}
          />
        </Suspense>
      )}

      {activeSeries && selectedSeries && (
        <Suspense fallback={null}>
          <SeriesDetailsDialog
            key={activeSeries.id}
            seriesId={activeSeries.id}
            seriesTitle={activeSeries.title}
            seriesPoster={activeSeries.posterUrl}
            sourceId={activeSeries.sourceId}
            sourceItemId={activeSeries.sourceItemId}
            initialSeasonNumber={positiveNumber(activeSeries.seasonNum)}
            initialEpisodeNumber={positiveNumber(activeSeries.episodeNum)}
            versions={seriesVersions}
            onSelectVersion={selectSeriesVersion}
            onLoadFailed={onSeriesLoadFailed}
            onClose={closeSeries}
          />
        </Suspense>
      )}
    </>
  );
}
