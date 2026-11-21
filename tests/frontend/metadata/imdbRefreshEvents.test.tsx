// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => ({ listen: vi.fn() }));
const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
const notifications = vi.hoisted(() => ({
  notify: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@tauri-apps/api/core', () => core);
vi.mock('@tauri-apps/api/event', () => ({ listen: events.listen }));
vi.mock('@/shared/notifications/useNotificationStore', () => notifications);

import { useImdbRefreshEvents } from '@/modules/metadata/hooks/useImdbRefreshEvents';

let handler: ((event: { payload: { stage: string } }) => void) | null = null;
const send = (stage: string) => act(() => handler?.({ payload: { stage } }));

beforeEach(() => {
  vi.clearAllMocks();
  handler = null;
  events.listen.mockImplementation(async (_name: string, callback: typeof handler) => {
    handler = callback;
    return vi.fn();
  });
  core.invoke.mockResolvedValue({ matched: 10, total: 20 });
});

describe('IMDb refresh toasts', () => {
  it('announces a run once and reports its counts once', async () => {
    renderHook(() => useImdbRefreshEvents());
    await waitFor(() => expect(handler).not.toBeNull());

    send('checking');
    send('downloading');
    send('parsing');
    expect(notifications.notify.info).toHaveBeenCalledTimes(1);

    // A full refresh finishes with two 'done' events (backfill, then refresh).
    send('done');
    send('done');
    await waitFor(() => expect(notifications.notify.success).toHaveBeenCalledTimes(1));
  });

  it('keeps the quiet daily backfill quiet', async () => {
    renderHook(() => useImdbRefreshEvents());
    await waitFor(() => expect(handler).not.toBeNull());

    send('done');
    await Promise.resolve();
    expect(notifications.notify.info).not.toHaveBeenCalled();
    expect(notifications.notify.success).not.toHaveBeenCalled();
  });

  it('announces the next run after a failed one', async () => {
    renderHook(() => useImdbRefreshEvents());
    await waitFor(() => expect(handler).not.toBeNull());

    send('checking');
    send('failed');
    send('checking');
    expect(notifications.notify.info).toHaveBeenCalledTimes(2);
  });
});
