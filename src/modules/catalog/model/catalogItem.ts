import type { MediaItem } from './media';

export interface CatalogItem extends MediaItem {
  categoryId?: string | undefined;
  /** The source's guide id for a channel — how XMLTV listings are matched. */
  epgChannelId?: string | undefined;
  radio?: boolean | undefined;
  radioMetadata?:
    | {
        title: string;
        artist?: string | undefined;
        album?: string | undefined;
        genre?: string | undefined;
        channelNumber?: string | undefined;
        logoUrl?: string | undefined;
      }
    | undefined;
  catchup?: string | undefined;
  catchupSource?: string | undefined;
  catchupDays?: number | undefined;
  fallbacks?:
    Array<{ streamUrl: string; httpHeaders?: Record<string, string> | undefined }> | undefined;
}
