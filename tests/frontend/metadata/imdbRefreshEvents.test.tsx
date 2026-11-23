// @vitest-environment happy-dom

import { act, render, screen, waitFor } from '@testing-library/react';
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
import { DataActivityStatus } from '@/app/components/DataActivityStatus';
import type { ImdbRefreshEvent } from '@/platform/tauri';

let handler: ((event: { payload: ImdbRefreshEvent }) => void) | null = null;
const send = (stage: string, details: Omit<ImdbRefreshEvent, 'stage'> = {}) =>
  act(() => handler?.({ payload: { stage, ...details } }));

function Activity() {
  useImdbRefreshEvents();
  return <DataActivityStatus compact={false} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  handler = null;
  events.listen.mockImplementation(async (_name: string, callback: typeof handler) => {
    handler = callback;
    return vi.fn();
  });
  core.invoke.mockResolvedValue({ importProgress: null, matched: 10, total: 20 });
});

describe('IMDb import activity', () => {
  it('shows download percentages and keeps importing visible until the run ends', async () => {
    render(<Activity />);
    await waitFor(() => expect(handler).not.toBeNull());

    send('checking');
    expect(screen.getByText('Importing IMDb data…')).toBeTruthy();
    expect(screen.getByText('Checking the library for titles to match')).toBeTruthy();
    send('downloading', { dataset: 'ratings', percent: 33 });
    expect(
      screen
        .getByRole('progressbar', { name: 'Downloading IMDb ratings…' })
        .getAttribute('aria-valuenow'),
    ).toBe('33');
    send('downloading', { dataset: 'titles', percent: null });
    expect(screen.getByText('Downloading IMDb titles…')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    send('parsing');
    expect(screen.getByText('Importing IMDb data…')).toBeTruthy();
    expect(screen.getByText('Reading downloaded IMDb files')).toBeTruthy();
    send('matching');
    expect(screen.getByText('Matching IMDb ratings…')).toBeTruthy();
    expect(notifications.notify.info).not.toHaveBeenCalled();

    send('done');
    send('done');
    expect(screen.getByRole('status').textContent).toBe('');
    await waitFor(() => expect(notifications.notify.success).toHaveBeenCalledTimes(1));
  });

  it('picks up an import that started before the listener mounted', async () => {
    core.invoke.mockResolvedValueOnce({
      importProgress: { stage: 'downloading', dataset: 'titles', percent: 42 },
    });
    render(<Activity />);

    const progress = await screen.findByRole('progressbar', { name: 'Downloading IMDb titles…' });
    expect(progress.getAttribute('aria-valuenow')).toBe('42');
  });

  it('keeps the quiet daily backfill quiet', async () => {
    render(<Activity />);
    await waitFor(() => expect(handler).not.toBeNull());

    send('done');
    await Promise.resolve();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(notifications.notify.info).not.toHaveBeenCalled();
    expect(notifications.notify.success).not.toHaveBeenCalled();
  });

  it('clears a failed run and shows the next one', async () => {
    render(<Activity />);
    await waitFor(() => expect(handler).not.toBeNull());

    send('checking');
    send('failed');
    expect(screen.getByRole('status').textContent).toBe('');
    send('checking');
    expect(screen.getByText('Importing IMDb data…')).toBeTruthy();
  });
});
