// app/store.ts —— 全局状态（Zustand）
// 对应设计文档 §8 状态管理

import { create } from 'zustand';
import type { PlayerEvent, PlayerState } from '../player/scheduler';
import { reducer } from '../player/scheduler';

export interface AppStore extends PlayerState {
  dispatch: (e: PlayerEvent) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  items: [],
  index: 0,
  paused: false,
  dispatch: (e) => set((s) => reducer(s, e)),
}));
