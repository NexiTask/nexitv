// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApi } from '@/platform/desktop';
import { tauriApi } from '@/platform/tauri';
import { StorageSettingsSection } from '@/modules/settings/components/StorageSettingsSection';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';

function renderStorageSettings() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <StorageSettingsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
});

describe('StorageSettingsSection', () => {
  it('shows the native default and keeps a selected folder until reset', async () => {
    const defaultFolder = '/home/test/Downloads';
    const chosenFolder = '/home/test/Videos';
    vi.spyOn(desktopApi, 'isDesktop').mockReturnValue(true);
    vi.spyOn(tauriApi, 'downloadDefaultDirectory').mockResolvedValue(defaultFolder);
    vi.spyOn(desktopApi, 'openPath').mockResolvedValue(chosenFolder);
    const user = userEvent.setup();
    renderStorageSettings();

    expect(await screen.findByText(`Default download folder is ${defaultFolder}.`)).toBeTruthy();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Download save folder' });
    expect(input.value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Choose download folder' }));
    expect(input.value).toBe(chosenFolder);
    expect(useSettingsStore.getState().downloadDirectory).toBe(chosenFolder);
    await user.click(screen.getByRole('button', { name: 'Use system Downloads folder' }));
    expect(input.value).toBe('');
    expect(screen.getByText(`Default download folder is ${defaultFolder}.`)).toBeTruthy();
  });

  it('updates recording and download settings', () => {
    renderStorageSettings();

    const recordingInput = screen.getByLabelText('Recording save folder');
    fireEvent.change(recordingInput, { target: { value: 'Custom Recordings' } });
    expect(useSettingsStore.getState().recordingPath).toBe('Custom Recordings');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Quick Record button' }));
    expect(useSettingsStore.getState().instantRecord).toBe(true);

    const downloadsInput = screen.getByLabelText('Download save folder');
    fireEvent.change(downloadsInput, { target: { value: 'D:\\Downloads' } });
    expect(useSettingsStore.getState().downloadDirectory).toBe('D:\\Downloads');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Start downloads automatically' }));
    expect(useSettingsStore.getState().autoStartDownloads).toBe(false);
  });
});
