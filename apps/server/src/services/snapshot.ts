/**
 * 增量快照（替代全量备份的自动留存体系）。
 *
 * 存储布局（env.backupDir 下）：
 *   snapshots/
 *     blobs/<sha前2位>/<sha256>   内容寻址照片仓库：同一份照片全库只存一次，
 *                                 新快照只复制「上次之后新增」的照片，这就是"增量"。
 *     <snapshotId>/
 *       manifest.json            清单：db 校验值 + 每张照片的 sha256（逐一校验的依据）
 *       app.db                   数据库一致性拷贝（VACUUM INTO，含全部衣橱）
 *       data.json                JSON 全量导出（便于人工查阅/跨版本恢复）
 *
 * 留存策略（按周）：每周保留最新一份，超出 SNAPSHOT_KEEP_WEEKS 的删除，
 * 删除后回收不再被任何清单引用的 blob。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { databaseFilePath } from '../lib/database.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { collectExportData } from './export.js';

export interface SnapshotPhotoEntry {
  /** 相对 uploads 目录的路径（与数据库 storage_path / thumb_path 一致） */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface SnapshotManifest {
  version: 1;
  id: string;
  createdAt: string;
  trigger: 'manual' | 'schedule';
  db: { file: string; sha256: string; sizeBytes: number };
  photos: SnapshotPhotoEntry[];
  stats: {
    /** 数据库里的照片记录数 */
    photoCount: number;
    /** 清单里的文件数（原图 + 缩略图） */
    fileCount: number;
    /** 本次新写入 blob 仓库的文件数（增量部分） */
    newBlobs: number;
    /** 已在仓库里、本次直接复用的文件数 */
    reusedBlobs: number;
    blobBytes: number;
    /** 磁盘文件 sha256 与数据库记录不一致的照片数（落快照时顺带做的一致性校验） */
    dbMismatches: number;
    /** 数据库有记录但磁盘已丢失的文件数 */
    dbMissing: number;
  };
  verify?: { checkedAt: string; ok: boolean; missing: number; corrupted: number };
}

export interface SnapshotVerifyReport {
  id: string;
  ok: boolean;
  checkedAt: string;
  dbOk: boolean;
  checked: number;
  missing: string[];
  corrupted: string[];
}

function snapshotsRoot(): string {
  return join(env.backupDir, 'snapshots');
}

function blobsRoot(): string {
  return join(snapshotsRoot(), 'blobs');
}

function blobPathFor(sha256: string): string {
  return join(blobsRoot(), sha256.slice(0, 2), sha256);
}

function snapshotDir(id: string): string {
  return join(snapshotsRoot(), id);
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** 写文件：先写临时文件再改名，避免中途崩溃留下半个文件 */
async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  await copyFile(source, tmp);
  await rename(tmp, target);
}

/**
 * 创建一份增量快照。
 * 照片逐一计算 sha256 并与数据库记录比对（一致性校验），
 * 只有仓库里还没有的 blob 才会真正落盘。
 */
export async function createSnapshot(trigger: 'manual' | 'schedule' = 'manual'): Promise<SnapshotManifest> {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const id = `${stamp}_${randomBytes(3).toString('hex')}`;
  const dir = snapshotDir(id);
  await mkdir(join(dir), { recursive: true });

  // 1. 数据库一致性拷贝：VACUUM INTO 自带读一致性，复制中途有写入也不会拿到半个事务
  const dbTmp = join(dir, `app.db.tmp-${randomBytes(4).toString('hex')}`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${dbTmp.replace(/'/gu, "''")}'`);
  await rename(dbTmp, join(dir, 'app.db'));
  const dbStat = await stat(join(dir, 'app.db'));
  const dbSha256 = await sha256File(join(dir, 'app.db'));

  // 2. JSON 全量导出（便于人工查阅，恢复仍以 app.db 为准）
  const data = await collectExportData();
  await writeFileAtomic(join(dir, 'data.json'), JSON.stringify(data, null, 2));

  // 3. 照片入内容寻址仓库（增量：已存在的 blob 直接复用）
  const photos = await prisma.garmentPhoto.findMany({
    where: { deletedAt: null },
    select: { storagePath: true, thumbPath: true, sha256: true },
  });
  const entries: SnapshotPhotoEntry[] = [];
  let newBlobs = 0;
  let reusedBlobs = 0;
  let blobBytes = 0;
  let dbMismatches = 0;
  let dbMissing = 0;

  for (const photo of photos) {
    for (const relative of [photo.storagePath, photo.thumbPath]) {
      const absolute = join(env.uploadDir, relative);
      let sha256: string;
      let sizeBytes: number;
      try {
        sha256 = await sha256File(absolute);
        sizeBytes = (await stat(absolute)).size;
      } catch {
        dbMissing += 1;
        logger.warn({ path: relative, snapshot: id }, 'snapshot: 数据库有记录但文件丢失');
        continue;
      }
      // 原图的 sha256 应与数据库记录一致；不一致说明磁盘文件被改动过
      if (relative === photo.storagePath && sha256 !== photo.sha256) {
        dbMismatches += 1;
        logger.warn({ path: relative, expected: photo.sha256, actual: sha256 }, 'snapshot: 照片与数据库记录不一致');
      }
      const blob = blobPathFor(sha256);
      if (existsSync(blob)) {
        reusedBlobs += 1;
      } else {
        await mkdir(join(blob, '..'), { recursive: true });
        await copyFileAtomic(absolute, blob);
        newBlobs += 1;
      }
      blobBytes += sizeBytes;
      entries.push({ path: relative, sha256, sizeBytes });
    }
  }

  const manifest: SnapshotManifest = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    trigger,
    db: { file: 'app.db', sha256: dbSha256, sizeBytes: dbStat.size },
    photos: entries,
    stats: {
      photoCount: photos.length,
      fileCount: entries.length,
      newBlobs,
      reusedBlobs,
      blobBytes,
      dbMismatches,
      dbMissing,
    },
  };
  await writeFileAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  logger.info({ id, trigger, ...manifest.stats }, 'snapshot created');
  return manifest;
}

export async function readManifest(id: string): Promise<SnapshotManifest> {
  if (!/^[\w-]+$/u.test(id)) throw new HttpError('VALIDATION_FAILED', '快照 id 不合法');
  const file = join(snapshotDir(id), 'manifest.json');
  if (!existsSync(file)) throw new HttpError('NOT_FOUND', `快照 ${id} 不存在`);
  return JSON.parse(await readFile(file, 'utf8')) as SnapshotManifest;
}

/** 列出全部快照（新的在前）。blobs 目录不是快照，跳过。 */
export async function listSnapshots(): Promise<SnapshotManifest[]> {
  const root = snapshotsRoot();
  if (!existsSync(root)) return [];
  const manifests: SnapshotManifest[] = [];
  for (const name of await readdir(root)) {
    if (name === 'blobs') continue;
    const file = join(root, name, 'manifest.json');
    if (!existsSync(file)) continue;
    try {
      manifests.push(JSON.parse(await readFile(file, 'utf8')) as SnapshotManifest);
    } catch {
      logger.warn({ snapshot: name }, 'snapshot: manifest 无法解析，已跳过');
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 逐张照片校验：清单里的每个 blob 重新算 sha256，与清单记录比对；数据库拷贝也校验。 */
export async function verifySnapshot(id: string): Promise<SnapshotVerifyReport> {
  const manifest = await readManifest(id);
  const missing: string[] = [];
  const corrupted: string[] = [];

  let dbOk = false;
  const dbFile = join(snapshotDir(id), manifest.db.file);
  try {
    dbOk = (await sha256File(dbFile)) === manifest.db.sha256;
  } catch {
    dbOk = false;
  }
  if (!dbOk) corrupted.push(manifest.db.file);

  for (const entry of manifest.photos) {
    const blob = blobPathFor(entry.sha256);
    if (!existsSync(blob)) {
      missing.push(entry.path);
      continue;
    }
    if ((await sha256File(blob)) !== entry.sha256) corrupted.push(entry.path);
  }

  const report: SnapshotVerifyReport = {
    id,
    ok: dbOk && missing.length === 0 && corrupted.length === 0,
    checkedAt: new Date().toISOString(),
    dbOk,
    checked: manifest.photos.length,
    missing,
    corrupted,
  };
  // 校验结果写回清单，设置页可以直接展示每份快照的健康状态
  manifest.verify = {
    checkedAt: report.checkedAt,
    ok: report.ok,
    missing: missing.length,
    corrupted: corrupted.length,
  };
  await writeFileAtomic(join(snapshotDir(id), 'manifest.json'), JSON.stringify(manifest, null, 2));
  return report;
}

export async function verifyAllSnapshots(): Promise<{ total: number; ok: number; reports: SnapshotVerifyReport[] }> {
  const manifests = await listSnapshots();
  const reports: SnapshotVerifyReport[] = [];
  for (const manifest of manifests) {
    reports.push(await verifySnapshot(manifest.id));
  }
  return { total: reports.length, ok: reports.filter((r) => r.ok).length, reports };
}

/**
 * 覆盖度校验（snapshot:verify 用）：当前数据库里的每张照片，
 * 是否都被最新一份快照覆盖。新拍的照片在下一次快照前会显示为未覆盖，属正常。
 */
export async function verifyCoverage(): Promise<{ total: number; covered: number; uncovered: string[] }> {
  const [latest] = await listSnapshots();
  const photos = await prisma.garmentPhoto.findMany({
    where: { deletedAt: null },
    select: { storagePath: true, thumbPath: true },
  });
  if (!latest) return { total: photos.length * 2, covered: 0, uncovered: photos.flatMap((p) => [p.storagePath, p.thumbPath]) };
  const inSnapshot = new Set(latest.photos.map((p) => p.path));
  const uncovered: string[] = [];
  for (const photo of photos) {
    for (const relative of [photo.storagePath, photo.thumbPath]) {
      if (!inSnapshot.has(relative)) uncovered.push(relative);
    }
  }
  return { total: photos.length * 2, covered: photos.length * 2 - uncovered.length, uncovered };
}

/** ISO 周所在的周一（UTC），用于按周留存 */
function mondayOfWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.getTime();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 按周留存：最新一份永远保留；其余每周只留最新一份；
 * 周龄超过 keepWeeks 的删除。返回被删除的快照 id 与回收的 blob 数。
 */
export async function applyRetention(
  keepWeeks: number = env.snapshotKeepWeeks,
  now: Date = new Date(),
): Promise<{ removed: string[]; kept: number; blobsGc: number }> {
  const manifests = await listSnapshots();
  const currentMonday = mondayOfWeek(now);
  const seenWeeks = new Set<number>();
  const removed: string[] = [];

  for (const [index, manifest] of manifests.entries()) {
    const monday = mondayOfWeek(new Date(manifest.createdAt));
    const weekAge = Math.floor((currentMonday - monday) / WEEK_MS);
    const keep = index === 0 || (weekAge <= keepWeeks && !seenWeeks.has(monday));
    if (keep) {
      seenWeeks.add(monday);
    } else {
      await rm(snapshotDir(manifest.id), { recursive: true, force: true });
      removed.push(manifest.id);
    }
  }

  const blobsGc = await gcBlobs();
  if (removed.length > 0 || blobsGc > 0) {
    logger.info({ removed, blobsGc }, 'snapshot retention applied');
  }
  return { removed, kept: manifests.length - removed.length, blobsGc };
}

/** 回收不再被任何快照清单引用的 blob */
async function gcBlobs(): Promise<number> {
  const root = blobsRoot();
  if (!existsSync(root)) return 0;
  const referenced = new Set<string>();
  for (const manifest of await listSnapshots()) {
    for (const photo of manifest.photos) referenced.add(photo.sha256);
  }
  let removed = 0;
  for (const prefix of await readdir(root)) {
    const dir = join(root, prefix);
    if (!(await stat(dir)).isDirectory()) continue;
    for (const file of await readdir(dir)) {
      if (referenced.has(file)) continue;
      await rm(join(dir, file), { force: true });
      removed += 1;
    }
    // 空的前缀目录顺手清掉
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
  }
  return removed;
}

/**
 * 从快照恢复：先逐张照片校验完整性，全部通过才动手。
 * 数据库替换前自动留 .before-restore.bak（需重启服务生效）。
 */
export async function restoreSnapshot(id: string): Promise<{ dbRestored: boolean; filesRestored: number }> {
  const report = await verifySnapshot(id);
  if (!report.ok) {
    throw new HttpError('VALIDATION_FAILED', '快照校验未通过，已中止恢复', {
      missing: report.missing,
      corrupted: report.corrupted,
    });
  }
  const manifest = await readManifest(id);

  const dbPath = databaseFilePath();
  const dbSource = join(snapshotDir(id), manifest.db.file);
  const tmp = `${dbPath}.restore-tmp`;
  await copyFile(dbSource, tmp);
  if (existsSync(dbPath)) {
    await copyFile(dbPath, `${dbPath}.before-restore.bak`);
  }
  await rename(tmp, dbPath);

  let filesRestored = 0;
  for (const entry of manifest.photos) {
    const target = join(env.uploadDir, entry.path);
    if (entry.path.includes('..')) continue;
    await mkdir(join(target, '..'), { recursive: true });
    await copyFile(blobPathFor(entry.sha256), target);
    filesRestored += 1;
  }
  return { dbRestored: true, filesRestored };
}

/** 调度器每周跑：落快照 → 按周留存 → 逐张照片校验新快照 */
export async function runWeeklySnapshot(): Promise<{ id: string; verifyOk: boolean; removed: string[] }> {
  const manifest = await createSnapshot('schedule');
  const retention = await applyRetention();
  const report = await verifySnapshot(manifest.id);
  if (!report.ok) {
    logger.error({ id: manifest.id, missing: report.missing, corrupted: report.corrupted }, 'weekly snapshot verify failed');
  }
  return { id: manifest.id, verifyOk: report.ok, removed: retention.removed };
}
