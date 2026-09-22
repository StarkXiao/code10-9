/**
 * 照片一致性校验：磁盘文件的 sha256 必须与数据库 garment_photos 记录一致。
 *
 * 增量快照与 CLI（npm run verify:media）共用同一份实现，
 * 保证「拍快照时校验」与「平时巡检」口径完全相同。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prisma } from '../lib/prisma.js';
import { absolutePath } from './image.js';

export interface PhotoVerificationRow {
  id: string;
  garmentId: string;
  storagePath: string;
  thumbPath: string | null;
  sha256: string;
  /** 主图状态：ok / missing / corrupted */
  status: 'ok' | 'missing' | 'corrupted';
  /** 缩略图状态：库里没有缩略图哈希，只核对文件是否存在、能否读取 */
  thumbStatus: 'ok' | 'missing' | 'unreadable';
}

export interface PhotoVerification {
  total: number;
  ok: number;
  missing: string[];
  corrupted: string[];
  thumbMissing: string[];
  thumbUnreadable: string[];
  photos: PhotoVerificationRow[];
}

async function fileState(path: string): Promise<'ok' | 'missing' | 'unreadable'> {
  try {
    await readFile(path);
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/**
 * 逐张核对未删除照片：
 *   - 主图：必须存在且 sha256 与库记录一致；
 *   - 缩略图：必须存在且可读取（缩略图可随时由主图重建，不单列哈希）。
 */
export async function verifyPhotos(): Promise<PhotoVerification> {
  const photos = await prisma.garmentPhoto.findMany({
    where: { deletedAt: null },
    select: { id: true, garmentId: true, storagePath: true, thumbPath: true, sha256: true },
    orderBy: { createdAt: 'asc' },
  });

  const rows: PhotoVerificationRow[] = [];
  const missing: string[] = [];
  const corrupted: string[] = [];
  const thumbMissing: string[] = [];
  const thumbUnreadable: string[] = [];
  let ok = 0;

  for (const photo of photos) {
    let status: PhotoVerificationRow['status'] = 'ok';
    try {
      const buffer = await readFile(absolutePath(photo.storagePath));
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (hash !== photo.sha256) status = 'corrupted';
    } catch (error) {
      status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupted';
    }

    let thumbStatus: PhotoVerificationRow['thumbStatus'] = 'ok';
    if (photo.thumbPath) {
      thumbStatus = await fileState(absolutePath(photo.thumbPath));
    } else {
      thumbStatus = 'missing';
    }

    if (status === 'ok') ok += 1;
    else if (status === 'missing') missing.push(photo.id);
    else corrupted.push(photo.id);

    if (thumbStatus === 'missing') thumbMissing.push(photo.id);
    else if (thumbStatus === 'unreadable') thumbUnreadable.push(photo.id);

    rows.push({ ...photo, status, thumbStatus });
  }

  return { total: photos.length, ok, missing, corrupted, thumbMissing, thumbUnreadable, photos: rows };
}
