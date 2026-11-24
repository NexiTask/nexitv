import { useState, useEffect, useCallback } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { VirtualizedGrid } from '@/modules/catalog/public/components/VirtualizedGrid';
import { isQueuedEpisode, useLibraryStore } from '../store/useLibraryStore';
import { CatalogViewToggle } from '@/modules/catalog/public/components/CatalogViewToggle';
import {
  Bookmark,
  CalendarClock,
  Download,
  Heart,
  FolderHeart,
  History,
  ListVideo,
  Sparkles,
  Plus,
  Edit2,
  Trash2,
  X,
} from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { HeaderSearch } from '@/modules/search/public/components/HeaderSearch';
import appStyles from '@/app/shell/AppLayout.module.css';
import styles from './LibraryPage.module.css';
import { useSettingsStore } from '@/modules/settings/public/store/useSettingsStore';
import { WorkspaceSidebar } from '@/shared/ui/WorkspaceSidebar';
import { CatalogPageHeader } from '@/modules/catalog/public/components/CatalogPageHeader';
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog';
import { Button, IconButton } from '@/shared/ui/Button';
import { DialogShell } from '@/shared/ui/DialogShell';
import { MediaDetailsDialogs } from '@/modules/catalog/public/details/MediaDetailsDialogs';
import { useMediaDetailState } from '@/modules/catalog/public/hooks/useMediaDetailsState';
import { DownloadsPanel } from '@/modules/downloads/public/components/DownloadsPanel';
import { useDownloadStore } from '@/modules/downloads/public/store/useDownloadStore';
import { UpcomingSchedule } from '@/modules/guide/public/components/UpcomingSchedule';
import { useWatchNext } from '@/modules/catalog/public/data/useWatchNext';
import { ContinueWatchingList } from './ContinueWatchingList';
import { WatchNextList } from './WatchNextList';
import { RecommendationsList } from './RecommendationsList';
import { useI18n } from '@/shared/i18n/i18n';

export function LibraryPage() {
  const { t, tn, number } = useI18n();
  const { listId } = useParams<'listId'>();
  const navigate = useNavigate();
  const history = useLibraryStore((state) => state.history);
  const resumeItems = history.filter((item) => !isQueuedEpisode(item));
  const watchNext = useWatchNext();
  const savedItems = useLibraryStore((state) => state.savedItems);
  const downloadCount = useDownloadStore((state) => state.jobs.length);
  const favorites = useLibraryStore((state) => state.favorites);
  const collections = useLibraryStore((state) => state.collections);
  const createCollection = useLibraryStore((state) => state.createCollection);
  const renameCollection = useLibraryStore((state) => state.renameCollection);
  const deleteCollection = useLibraryStore((state) => state.deleteCollection);
  const upcomingEnabled = useSettingsStore((state) => state.upcomingEnabled);
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth);
  const lastCollectionId = useSettingsStore((state) => state.lastCollectionId);
  const updateSetting = useSettingsStore((state) => state.updateSetting);
  const builtInLists = [
    {
      id: 'continue',
      name: 'Continue Watching',
      icon: History,
      items: resumeItems,
    },
    {
      id: 'watch-next',
      name: 'Watch Next',
      icon: ListVideo,
      items: watchNext.items,
    },
    {
      id: 'upcoming',
      name: 'Coming Up',
      icon: CalendarClock,
    },
    {
      id: 'recommendations',
      name: 'Recommendations',
      icon: Sparkles,
    },
    {
      id: 'saved',
      name: 'Saved',
      icon: Bookmark,
      items: savedItems,
      emptyTitle: 'No saved items',
      emptyDescription: 'Use Add to Library to save an item here.',
    },
    {
      id: 'favorites',
      name: 'Favorites',
      icon: Heart,
      items: favorites,
      emptyTitle: 'Your Favorites Are Empty',
      emptyDescription: 'Use the heart on a movie, series, or live channel to add it to Favorites.',
    },
    {
      id: 'downloads',
      name: 'Downloads',
      icon: Download,
      count: downloadCount,
    },
  ];
  const visibleBuiltInLists = builtInLists.filter(
    (list) => upcomingEnabled || list.id !== 'upcoming',
  );
  const builtInList = builtInLists.find((list) => list.id === listId);
  const activeCollection = builtInList
    ? undefined
    : collections.find((collection) => collection.id === listId);
  const selectedList = builtInList ?? activeCollection;
  const selectedCollectionId =
    listId === 'upcoming' && !upcomingEnabled ? undefined : selectedList?.id;

  useEffect(() => {
    if (selectedCollectionId !== undefined && selectedCollectionId !== lastCollectionId) {
      updateSetting('lastCollectionId', selectedCollectionId);
    }
  }, [selectedCollectionId, lastCollectionId, updateSetting]);

  const { selectedMovie, selectedSeries, handleCloseMovie, handleCloseSeries, handleItemClick } =
    useMediaDetailState({
      enableSourceOnOpen: listId !== 'upcoming',
    });

  // Modal states for Create, Rename, Delete
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameCollectionName, setRenameCollectionName] = useState('');
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const closeCreateModal = useCallback(() => setIsCreateOpen(false), []);
  const closeRenameModal = useCallback(() => setIsRenameOpen(false), []);

  if (listId === 'automated-recommendations') {
    return <Navigate to="/library/recommendations" replace />;
  }
  if (!selectedList) {
    const lastList =
      listId === undefined &&
      (visibleBuiltInLists.some((list) => list.id === lastCollectionId) ||
        collections.some((collection) => collection.id === lastCollectionId));
    return <Navigate to={`/library/${lastList ? lastCollectionId : 'saved'}`} replace />;
  }

  const { items = [] } = selectedList;

  const openCreateModal = () => {
    setNewCollectionName('');
    setIsCreateOpen(true);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newCollectionName && newCollectionName.trim()) {
      const id = createCollection(newCollectionName.trim());
      setIsCreateOpen(false);
      void navigate(`/library/${id}`);
    }
  };

  const openRenameModal = () => {
    if (!activeCollection) return;
    setRenameCollectionName(activeCollection.name);
    setIsRenameOpen(true);
  };

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeCollection && renameCollectionName && renameCollectionName.trim()) {
      renameCollection(activeCollection.id, renameCollectionName.trim());
      setIsRenameOpen(false);
    }
  };

  const openDeleteModal = () => {
    if (!activeCollection) return;
    setIsDeleteOpen(true);
  };

  const handleDeleteSubmit = () => {
    if (!activeCollection) return;
    deleteCollection(activeCollection.id);
    setIsDeleteOpen(false);
    void navigate('/library/saved', { replace: true });
  };

  return (
    <>
      <div className={`${appStyles.page} ${styles.libraryPage}`}>
        <WorkspaceSidebar
          title="Library"
          width={sidebarWidth}
          onWidthChange={(width) => updateSetting('sidebarWidth', width)}
          headerAction={
            <Button
              size="sm"
              onClick={openCreateModal}
              title="Create Collection"
              aria-label="Create Collection"
              className={styles.newBtn}
            >
              <Plus size={13} />
              <span>{t('New')}</span>
            </Button>
          }
        >
          {visibleBuiltInLists.map(({ id, name, icon: Icon, items, count = items?.length }) => (
            <NavLink
              key={id}
              to={`/library/${id}`}
              end
              className={styles.collectionRow ?? ''}
              aria-label={t(name)}
            >
              <Icon size={16} className={styles.listIcon} aria-hidden="true" />
              <span className={styles.collectionName}>{t(name)}</span>
              {count !== undefined && (
                <span className={styles.collectionCount} aria-hidden="true">
                  {number(count)}
                </span>
              )}
            </NavLink>
          ))}
          {collections.map((collection) => (
            <NavLink
              key={collection.id}
              to={`/library/${collection.id}`}
              end
              className={styles.collectionRow ?? ''}
              aria-label={collection.name}
            >
              <span className={styles.collectionName}>{collection.name}</span>
              <span className={styles.collectionCount} aria-hidden="true">
                {number(collection.items.length)}
              </span>
            </NavLink>
          ))}
        </WorkspaceSidebar>

        <div className={appStyles.catalogMain}>
          {listId === 'continue' ? (
            <ContinueWatchingList items={resumeItems} onItemClick={handleItemClick} />
          ) : listId === 'watch-next' ? (
            <WatchNextList queue={watchNext} onItemClick={handleItemClick} />
          ) : listId === 'upcoming' ? (
            <UpcomingSchedule onOpen={handleItemClick} />
          ) : listId === 'recommendations' ? (
            <RecommendationsList next={watchNext.items} onOpen={handleItemClick} />
          ) : listId === 'downloads' ? (
            <DownloadsPanel />
          ) : (
            <>
              <CatalogPageHeader
                title={selectedList.name}
                meta={tn('{count} item', '{count} items', items.length, {
                  count: number(items.length),
                })}
                titleActions={
                  activeCollection ? (
                    <div className={styles.collectionActions}>
                      <IconButton
                        size="sm"
                        onClick={openRenameModal}
                        title="Rename Collection"
                        aria-label="Rename Collection"
                        className={styles.actionBtn}
                      >
                        <Edit2 size={13} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        onClick={openDeleteModal}
                        title="Delete Collection"
                        aria-label="Delete Collection"
                        className={`${styles.actionBtn} ${styles.deleteBtn}`}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  ) : undefined
                }
                actions={
                  <>
                    <HeaderSearch onItemClick={handleItemClick} />
                    <CatalogViewToggle />
                  </>
                }
              />

              {items.length > 0 ? (
                <div className={appStyles.catalogContent}>
                  <VirtualizedGrid
                    items={items}
                    onItemClick={handleItemClick}
                    currentCollectionId={activeCollection?.id}
                  />
                </div>
              ) : (
                <EmptyState
                  icon={builtInList?.icon ?? FolderHeart}
                  title={builtInList?.emptyTitle ?? 'Collection Empty'}
                  description={
                    builtInList?.emptyDescription ??
                    t(
                      '"{name}" has no items yet. Add movies or series from their detail modals or context menus.',
                      { name: selectedList.name },
                    )
                  }
                />
              )}
            </>
          )}
        </div>

        <MediaDetailsDialogs
          selectedMovie={selectedMovie}
          selectedSeries={selectedSeries}
          onCloseMovie={handleCloseMovie}
          onCloseSeries={handleCloseSeries}
        />

        {/* Create Collection Modal */}
        {isCreateOpen && (
          <DialogShell
            onClose={closeCreateModal}
            className={styles.modalContent}
            ariaLabel={t('Create new collection')}
            initialFocusSelector="[data-modal-initial-focus]"
          >
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>{t('Create New Collection')}</h3>
              <IconButton
                size="sm"
                className={styles.modalCloseBtn}
                onClick={closeCreateModal}
                aria-label="Close"
              >
                <X size={16} />
              </IconButton>
            </div>
            <form onSubmit={handleCreateSubmit} className={styles.modalForm}>
              <input
                type="text"
                placeholder={t('Collection Name (e.g. Marvel Movies)')}
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                className={`${styles.modalInput} uiField`}
                data-modal-initial-focus
                aria-label={t('Collection name')}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <div className={styles.modalFooter}>
                <Button type="button" className={styles.modalCancelBtn} onClick={closeCreateModal}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" className={styles.modalSubmitBtn}>
                  Create Collection
                </Button>
              </div>
            </form>
          </DialogShell>
        )}

        {/* Rename Collection Modal */}
        {isRenameOpen && activeCollection && (
          <DialogShell
            onClose={closeRenameModal}
            className={styles.modalContent}
            ariaLabel={t('Rename {name}', { name: activeCollection.name })}
            initialFocusSelector="[data-modal-initial-focus]"
          >
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>{t('Rename Collection')}</h3>
              <IconButton
                size="sm"
                className={styles.modalCloseBtn}
                onClick={closeRenameModal}
                aria-label="Close"
              >
                <X size={16} />
              </IconButton>
            </div>
            <form onSubmit={handleRenameSubmit} className={styles.modalForm}>
              <input
                type="text"
                placeholder={t('Collection Name')}
                value={renameCollectionName}
                onChange={(e) => setRenameCollectionName(e.target.value)}
                className={`${styles.modalInput} uiField`}
                data-modal-initial-focus
                aria-label={t('Collection name')}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <div className={styles.modalFooter}>
                <Button type="button" className={styles.modalCancelBtn} onClick={closeRenameModal}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" className={styles.modalSubmitBtn}>
                  Save Changes
                </Button>
              </div>
            </form>
          </DialogShell>
        )}

        {/* Delete Collection Confirmation Modal */}
        {isDeleteOpen && activeCollection && (
          <ConfirmDialog
            title="Delete Collection?"
            description={t(
              'This removes “{name}” and its list. Media items and files are not deleted.',
              { name: activeCollection.name },
            )}
            confirmLabel="Delete Collection"
            danger
            onCancel={() => setIsDeleteOpen(false)}
            onConfirm={handleDeleteSubmit}
          />
        )}
      </div>
    </>
  );
}
