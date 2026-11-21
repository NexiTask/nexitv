// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as renderUi, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LibraryMetadataSettingsSection } from '@/modules/settings/components/LibraryMetadataSettingsSection';
import { useSettingsStore } from '@/modules/settings/store/useSettingsStore';

// The content filter reads the provider's categories.
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderUi(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
  useSettingsStore.setState({
    tmdbApiKey: 'test-key',
    tmdbEnabled: true,
    streamFoldingEnabled: true,
  });
});

describe('library and metadata settings', () => {
  it('toggles stream folding and tmdb enrichment', () => {
    render(<LibraryMetadataSettingsSection />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable live stream folding' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable TMDB enrichment' }));

    expect(useSettingsStore.getState().streamFoldingEnabled).toBe(false);
    expect(useSettingsStore.getState().tmdbEnabled).toBe(false);
  });

  it('toggles quality and format badges', () => {
    render(<LibraryMetadataSettingsSection />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show quality and format badges' }));

    expect(useSettingsStore.getState().badgeVisibility.resolution).toBe(false);
    expect(useSettingsStore.getState().badgeVisibility.fps).toBe(false);
    expect(useSettingsStore.getState().badgeVisibility.audio).toBe(false);
    expect(useSettingsStore.getState().badgeVisibility.edition).toBe(false);
  });

  it('disables subordinate controls when TMDB is turned off', () => {
    useSettingsStore.setState({ tmdbEnabled: false });
    render(<LibraryMetadataSettingsSection />);

    expect(
      screen.getByRole('checkbox', { name: 'Include adult TMDB results' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'TMDB metadata language' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'TMDB poster quality' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('adds and removes a hidden keyword', () => {
    render(<LibraryMetadataSettingsSection />);

    const input = screen.getByRole('textbox', { name: 'Keyword to hide' });
    fireEvent.change(input, { target: { value: '  Bollywood ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSettingsStore.getState().catalogHiddenKeywords).toEqual(['Bollywood']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bollywood' }));
    expect(useSettingsStore.getState().catalogHiddenKeywords).toEqual([]);
  });
});
