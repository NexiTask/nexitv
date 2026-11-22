import { create } from 'zustand';

export type DataActivity = 'catalog' | 'index' | 'playlist' | 'guide';

export const useDataActivities = create<Record<DataActivity, number>>(() => ({
  catalog: 0,
  index: 0,
  playlist: 0,
  guide: 0,
}));

export async function trackDataActivity<T>(
  activity: DataActivity,
  task: () => Promise<T>,
): Promise<T> {
  useDataActivities.setState((state) => ({ [activity]: state[activity] + 1 }));
  try {
    return await task();
  } finally {
    useDataActivities.setState((state) => ({ [activity]: state[activity] - 1 }));
  }
}
