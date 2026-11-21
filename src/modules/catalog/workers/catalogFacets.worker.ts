import { runCatalogFacetTask, type CatalogFacetTask } from '../lib/catalogFacetTasks';

self.addEventListener('message', (event: MessageEvent<{ id: number; task: CatalogFacetTask }>) => {
  const { id, task } = event.data;
  try {
    const result = runCatalogFacetTask(task);
    const transfer = result.op === 'ranks' ? [result.ranks.buffer] : [];
    self.postMessage({ id, result }, { transfer });
  } catch (error: unknown) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
