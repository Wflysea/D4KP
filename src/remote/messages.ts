// remote/messages.ts —— 远程控制指令协议
// 对应设计文档 §10

export type RemoteCommand =
  | { seq: number; action: 'play' | 'pause' }
  | { seq: number; action: 'next' | 'prev' }
  | { seq: number; action: 'select'; playlistId: string }
  | { seq: number; action: 'locate'; index: number };

/** 指令校验：确保字段存在且类型正确（防重放用 seq 递增） */
export function parseRemoteCommand(raw: unknown): RemoteCommand | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.seq !== 'number') return undefined;
  switch (o.action) {
    case 'play':
    case 'pause':
    case 'next':
    case 'prev':
      return { seq: o.seq, action: o.action };
    case 'select':
      if (typeof o.playlistId !== 'string') return undefined;
      return { seq: o.seq, action: 'select', playlistId: o.playlistId };
    case 'locate':
      if (typeof o.index !== 'number') return undefined;
      return { seq: o.seq, action: 'locate', index: o.index };
    default:
      return undefined;
  }
}
