import { useMutation, useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { desktopApi } from '@/platform/desktop';
import { tauriApi } from '@/platform/tauri';
import { useI18n } from '@/shared/i18n/i18n';
import { getErrorMessage } from '@/shared/lib/error';
import { notify } from '@/shared/notifications/useNotificationStore';
import { DialogShell } from '@/shared/ui/DialogShell';
import { Select } from '@/shared/ui/Select';
import { SettingsButton, SettingsGroup, SettingsRow } from './SettingsControls';
import styles from './ChatGptSettingsGroup.module.css';

const accountsKey = ['chatgpt', 'accounts'] as const;
const connectKey = ['chatgpt', 'connect'] as const;
const disconnectKey = ['chatgpt', 'disconnect'] as const;
const usageUrl = 'https://chatgpt.com/settings/usage';

export function ChatGptSettingsGroup() {
  const { t } = useI18n();
  const cache = useQueryClient();
  const [showWelcome, setShowWelcome] = useState(false);
  const status = useQuery({ queryKey: accountsKey, queryFn: tauriApi.chatGptStatus, retry: false });
  const connect = useMutation({
    mutationKey: connectKey,
    mutationFn: tauriApi.chatGptConnect,
    onSuccess: ({ status, firstPlanPermission }) => {
      cache.setQueryData(accountsKey, status);
      if (firstPlanPermission) setShowWelcome(true);
    },
    onError: (error) => {
      if (getErrorMessage(error, '') !== 'ChatGPT sign-in canceled.') reportError(error);
    },
  });
  const disconnect = useMutation({
    mutationKey: disconnectKey,
    mutationFn: tauriApi.chatGptDisconnect,
    onSuccess: ({ status, revocationConfirmed }) => {
      cache.setQueryData(accountsKey, status);
      if (!revocationConfirmed) {
        notify.warning(
          t('Signed out of ChatGPT on this device'),
          t('OpenAI could not confirm revocation. You can disconnect NexiTV in ChatGPT settings.'),
        );
      }
    },
    onError: reportError,
  });
  const connecting = useIsMutating({ mutationKey: connectKey }) > 0;
  const disconnecting = useIsMutating({ mutationKey: disconnectKey }) > 0;
  const busy = status.isPending || connecting || disconnecting;
  const active = status.data?.accounts.find(
    ({ clientId }) => clientId === status.data?.activeClient,
  );
  const accounts = status.data?.accounts ?? [];

  function reportError(error: unknown) {
    notify.error(t('ChatGPT connection'), t(getErrorMessage(error, 'Try again.')));
  }

  function manageUsage() {
    void desktopApi.openUrl(usageUrl).catch(reportError);
  }

  return (
    <SettingsGroup
      title="ChatGPT"
      description="Connect your ChatGPT account to let eligible NexiTV requests use your plan."
    >
      <SettingsRow
        title="ChatGPT account"
        description={
          <span role="status">
            {connecting
              ? t('Finish signing in in your browser.')
              : disconnecting
                ? t('Signing out…')
                : status.isError
                  ? t('Could not load the ChatGPT connection.')
                  : status.isPending
                    ? t('Checking the connection…')
                    : (active?.label ?? t('Signed out'))}
          </span>
        }
      >
        {connecting ? (
          <SettingsButton onClick={() => void tauriApi.chatGptCancel().catch(reportError)}>
            Cancel
          </SettingsButton>
        ) : status.isError ? (
          <SettingsButton onClick={() => void status.refetch()}>Retry</SettingsButton>
        ) : (
          <SettingsButton
            disabled={busy}
            data-oai-siwc-button=""
            onClick={() => connect.mutate(active?.clientId ?? null)}
          >
            Continue with ChatGPT
          </SettingsButton>
        )}
      </SettingsRow>
      {accounts.length > 0 && (
        <SettingsRow title="Saved accounts">
          <Select
            value={active?.clientId ?? ''}
            options={[
              { value: '', label: active ? 'Add account' : 'Choose an account' },
              ...accounts.map(({ clientId, label }) => ({
                value: clientId,
                label,
                localize: false,
              })),
              ...(!active ? [{ value: 'new', label: 'Add account' }] : []),
            ]}
            onChange={(value) => {
              if (!value && !active) return;
              connect.mutate(value && value !== 'new' ? value : null);
            }}
            disabled={busy}
            variant="settings"
            width={240}
            ariaLabel="Saved ChatGPT accounts"
          />
        </SettingsRow>
      )}
      {active && (
        <>
          <SettingsRow
            title="ChatGPT plan usage"
            description={
              active.planPermission
                ? 'Plan permission granted'
                : 'Plan permission has not been granted'
            }
          >
            <SettingsButton onClick={manageUsage}>Manage usage</SettingsButton>
          </SettingsRow>
          <SettingsRow title="Disconnect from this device">
            <SettingsButton disabled={busy} onClick={() => disconnect.mutate()}>
              Sign out
            </SettingsButton>
          </SettingsRow>
        </>
      )}
      {showWelcome && (
        <DialogShell
          className={styles.welcome}
          onClose={() => setShowWelcome(false)}
          ariaLabel={t('ChatGPT plan connected')}
          initialFocusSelector="[data-modal-initial-focus]"
        >
          <h2 className={styles.title}>{t('ChatGPT plan connected')}</h2>
          <p>
            {t(
              'Eligible AI requests can use your ChatGPT plan. You can manage app access and usage in ChatGPT settings.',
            )}
          </p>
          <div className={styles.actions}>
            <SettingsButton onClick={manageUsage}>Manage usage</SettingsButton>
            <SettingsButton
              variant="primary"
              data-modal-initial-focus
              onClick={() => setShowWelcome(false)}
            >
              Got it
            </SettingsButton>
          </div>
        </DialogShell>
      )}
    </SettingsGroup>
  );
}
