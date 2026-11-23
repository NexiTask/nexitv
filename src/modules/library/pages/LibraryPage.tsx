import { useState, useEffect, useCallback } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { VirtualizedGrid } from '@/modules/catalog/public/components/VirtualizedGrid';
import { useLibraryStore } from '../store/useLibraryStore';
import { CatalogViewToggle } from '@/modules/catalog/public/components/CatalogViewToggle';
import { Heart, FolderHeart, Plus, Edit2, Trash2, X } from 'lucide-react';
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
import { useI18n } from '@/shared/i18n/i18n';

export function LibraryPage() {
  const { t, tn, number } = useI18n();
  const { listId } = useParams<'listId'>();
  const navigate = useNavigate();
  const favorites = useLibraryStore((state) => state.favorites);
  const collections = useLibraryStore((state) => state.collections);
  const createCollection = useLibraryStore((state) => state.createCollection);
  const renameCollection = useLibraryStore((state) => state.renameCollection);
  const deleteCollection = useLibraryStore((state) => state.deleteCollection);
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth);
  const lastCollectionId = useSettingsStore((state) => state.lastCollectionId);
  const updateSetting = useSettingsStore((state) => state.updateSetting);
  const activeCollection = collections.find((collection) => collection.id === listId);
  const showingFavorites = listId === 'favorites';
  const items = activeCollection?.items ?? favorites;

  const selectedCollectionId = showingFavorites ? null : activeCollection?.id;
  useEffect(() => {
    if (selectedCollectionId !== undefined && selectedCollectionId !== lastCollectionId) {
      updateSetting('lastCollectionId', selectedCollectionId);
    }
  }, [selectedCollectionId, lastCollectionId, updateSetting]);

  const { selectedMovie, selectedSeries, handleCloseMovie, handleCloseSeries, handleItemClick } =
    useMediaDetailState({ enableSourceOnOpen: true });

  // Modal states for Create, Rename, Delete
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameCollectionName, setRenameCollectionName] = useState('');
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const closeCreateModal = useCallback(() => setIsCreateOpen(false), []);
  const closeRenameModal = useCallback(() => setIsRenameOpen(false), []);

  if (!showingFavorites && !activeCollection) {
    const lastCollection =
      listId === undefined && collections.find((collection) => collection.id === lastCollectionId);
    return <Navigate to={`/library/${lastCollection ? lastCollection.id : 'favorites'}`} replace />;
  }

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
    void navigate('/library/favorites', { replace: true });
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
          <NavLink
            to="/library/favorites"
            end
            className={styles.collectionRow ?? ''}
            aria-label={t('Favorites')}
          >
            <Heart size={16} className={styles.favoritesIcon} aria-hidden="true" />
            <span className={styles.collectionName}>{t('Favorites')}</span>
            <span className={styles.collectionCount} aria-hidden="true">
              {number(favorites.length)}
            </span>
          </NavLink>
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
          <CatalogPageHeader
            title={activeCollection?.name ?? 'Favorites'}
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
              icon={activeCollection ? FolderHeart : Heart}
              title={activeCollection ? 'Collection Empty' : 'Your Favorites Are Empty'}
              description={
                activeCollection
                  ? t(
                      '"{name}" has no items yet. Add movies or series from their detail modals or context menus.',
                      { name: activeCollection.name },
                    )
                  : 'Use the heart on a movie, series, or live channel to add it to Favorites.'
              }
            />
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
