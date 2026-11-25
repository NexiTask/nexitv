import { rankTitles, xtreamFacetRows, type CatalogFacetRow } from './catalogFacets';

/** Work the facet worker does on the index's raw JSON, off the webview thread. */
export type CatalogFacetTask =
  | { op: 'facets'; kind: 'live' | 'vod' | 'series'; sourceId: string; payload: ArrayBuffer }
  | { op: 'ranks'; payload: ArrayBuffer };

export type CatalogFacetTaskResult =
  | {
      op: 'facets';
      ready: boolean;
      generation: number;
      remaining: number | null;
      facets: CatalogFacetRow[];
    }
  | { op: 'ranks'; needed: boolean; token: string; ranks: Uint32Array };

function decode<T>(payload: ArrayBuffer): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}

export function runCatalogFacetTask(task: CatalogFacetTask): CatalogFacetTaskResult {
  if (task.op === 'facets') {
    const batch = decode<{
      ready: boolean;
      generation: number;
      remaining?: number | null;
      rows: Array<[number, unknown]>;
    }>(task.payload);
    return {
      op: 'facets',
      ready: batch.ready,
      generation: batch.generation,
      remaining: batch.remaining ?? null,
      facets: xtreamFacetRows(task.kind, task.sourceId, batch.rows),
    };
  }
  const batch = decode<{ needed: boolean; token: string; titles: string[] }>(task.payload);
  return {
    op: 'ranks',
    needed: batch.needed,
    token: batch.token,
    ranks: batch.needed ? rankTitles(batch.titles) : new Uint32Array(0),
  };
}
