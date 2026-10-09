import { describe, it, expect } from 'vitest';
import { reducer } from '../src/player/scheduler';
import type { PlayerState, PlayerEvent } from '../src/player/scheduler';
import type { Playlist, WallpaperItem } from '../src/types/domain';

const items: WallpaperItem[] = [
  { id: '1', accountId: 'a', path: '/1.jpg', kind: 'image', tags: [], favorite: false },
  { id: '2', accountId: 'a', path: '/2.jpg', kind: 'image', tags: [], favorite: false },
  { id: '3', accountId: 'a', path: '/3.jpg', kind: 'image', tags: [], favorite: false },
];

const seq: Playlist = {
  id: 'p',
  name: '顺序',
  source: { type: 'favorites', accountId: 'a' },
  order: 'sequential',
  transition: 'fade',
  dwellSec: 10,
};

const rand: Playlist = { ...seq, order: 'random' };

function state(order: Playlist): PlayerState {
  return { playlist: order, items, index: 0, paused: false };
}

describe('播放调度状态机', () => {
  it('SCHEDULE 重置到首项', () => {
    const s = reducer({ items, index: 2, paused: true }, { type: 'SCHEDULE', playlist: seq, items });
    expect(s.index).toBe(0);
    expect(s.paused).toBe(false); // 重新排片时自动恢复播放
  });

  it('TOGGLE_PAUSE 在暂停与恢复之间切换', () => {
    const s0 = reducer(state(seq), { type: 'TOGGLE_PAUSE' });
    expect(s0.paused).toBe(true);
    const s1 = reducer(s0, { type: 'TOGGLE_PAUSE' });
    expect(s1.paused).toBe(false);
    // 暂停状态不影响手动切图
    const s2 = reducer({ ...s1, paused: true }, { type: 'NEXT' });
    expect(s2.index).toBe(1);
    expect(s2.paused).toBe(true);
  });

  it('顺序模式下 TICK / NEXT 循环前进', () => {
    const s0 = reducer(state(seq), { type: 'NEXT' });
    expect(s0.index).toBe(1);
    const s1 = reducer({ ...s0, items, playlist: seq }, { type: 'TICK' });
    expect(s1.index).toBe(2);
    const s2 = reducer({ ...s1, items, playlist: seq }, { type: 'NEXT' });
    expect(s2.index).toBe(0); // 回到头部
  });

  it('PREV 循环后退', () => {
    const s = reducer(state(seq), { type: 'PREV' });
    expect(s.index).toBe(2);
  });

  it('JUMP 越界被夹紧', () => {
    const s = reducer(state(seq), { type: 'JUMP', index: 99 } as PlayerEvent);
    expect(s.index).toBe(2);
    const s2 = reducer(state(seq), { type: 'JUMP', index: -5 } as PlayerEvent);
    expect(s2.index).toBe(0);
  });

  it('随机模式索引落在范围内', () => {
    for (let i = 0; i < 50; i++) {
      const s = reducer(state(rand), { type: 'NEXT' });
      expect(s.index).toBeGreaterThanOrEqual(0);
      expect(s.index).toBeLessThan(items.length);
    }
  });
});
