// player/scheduler.ts —— 播放调度状态机（纯 TS，可单测）
// 对应设计文档 §7.1

import type { Playlist, WallpaperItem } from '../types/domain';

export type PlayerEvent =
  | { type: 'TICK' } // 停留超时，自动下一帧
  | { type: 'NEXT' }
  | { type: 'PREV' }
  | { type: 'JUMP'; index: number }
  | { type: 'TOGGLE_PAUSE' } // OK 键/媒体键：暂停或恢复自动轮播
  | { type: 'SCHEDULE'; playlist: Playlist; items: WallpaperItem[] };

export interface PlayerState {
  playlist?: Playlist;
  items: WallpaperItem[];
  index: number;
  /** 自动轮播是否暂停（手动切图不受影响） */
  paused: boolean;
}

function len(s: PlayerState): number {
  return s.items.length;
}

function clamp(i: number, n: number): number {
  return n === 0 ? 0 : Math.max(0, Math.min(i, n - 1));
}

function nextIndex(s: PlayerState): number {
  const n = len(s);
  if (n === 0) return 0;
  if (s.playlist?.order === 'random') return Math.floor(Math.random() * n);
  return (s.index + 1) % n;
}

function prevIndex(s: PlayerState): number {
  const n = len(s);
  if (n === 0) return 0;
  if (s.playlist?.order === 'random') return Math.floor(Math.random() * n);
  return (s.index - 1 + n) % n;
}

export function reducer(s: PlayerState, e: PlayerEvent): PlayerState {
  switch (e.type) {
    case 'SCHEDULE':
      return { playlist: e.playlist, items: e.items, index: 0, paused: false };
    case 'TICK':
    case 'NEXT':
      return { ...s, index: nextIndex(s) };
    case 'PREV':
      return { ...s, index: prevIndex(s) };
    case 'JUMP':
      return { ...s, index: clamp(e.index, len(s)) };
    case 'TOGGLE_PAUSE':
      return { ...s, paused: !s.paused };
    default:
      return s;
  }
}
