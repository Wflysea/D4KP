// types/domain.ts —— 领域模型（纯类型，无运行依赖）
// 对应设计文档 §4 核心数据模型

export type MediaKind = 'image' | 'video' | 'livephoto' | 'webp';

/** WebDAV PROPFIND 返回的单条资源 */
export interface DavResource {
  href: string; // 服务器侧完整路径
  name: string; // 文件名
  isCollection: boolean;
  etag?: string; // 用于增量比对
  lastModified?: number; // epoch ms
  contentLength?: number;
  contentType?: string;
}

/** 本地索引后的壁纸条目 */
export interface WallpaperItem {
  id: string; // 内容哈希（去重键）
  accountId: string;
  path: string; // NAS 相对路径
  kind: MediaKind;
  width?: number;
  height?: number;
  etag?: string;
  lastModified?: number;
  localCacheKey?: string; // 命中本地缓存时的键
  tags: string[];
  favorite: boolean;
  capturedAt?: number;
}

export type PlaylistSource =
  | { type: 'directory'; accountId: string; root: string }
  | { type: 'tag'; accountId: string; tag: string }
  | { type: 'favorites'; accountId: string };

export type TransitionKind = 'fade' | 'kenburns' | 'none';

export interface ScheduleRule {
  weekdays?: number[]; // 0=周日 ... 6=周六
  startHour?: number; // 含
  endHour?: number; // 不含
}

export interface Playlist {
  id: string;
  name: string;
  source: PlaylistSource;
  order: 'sequential' | 'random';
  transition: TransitionKind;
  dwellSec: number; // 单张停留时长
  schedule?: ScheduleRule;
}

export interface SyncState {
  accountId: string;
  lastFullScan?: number;
  cursor?: string; // 增量游标
  pending: string[];
  cacheBytes: number;
}
