// core/playlist/playlist-engine.ts —— 播放列表排程解析
// 对应设计文档 §3 / §6 排程

import type { Playlist } from '../../types/domain';

/** 依据当前时间，从播放列表集合中解析应激活的播放列表（设计文档 §5.6 排程） */
export function resolveActivePlaylist(playlists: Playlist[], now: Date = new Date()): Playlist | undefined {
  if (playlists.length === 0) return undefined;
  const wd = now.getDay();
  const h = now.getHours();
  const hit = playlists.find((p) => {
    const s = p.schedule;
    if (!s) return false;
    if (s.weekdays && !s.weekdays.includes(wd)) return false;
    if (s.startHour !== undefined && h < s.startHour) return false;
    if (s.endHour !== undefined && h >= s.endHour) return false;
    return true;
  });
  return hit ?? playlists[0];
}
