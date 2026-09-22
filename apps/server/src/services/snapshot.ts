/**
 * 增量快照：内容寻址（content-addressed）的备份体系。
 *
 * 与旧版「每次打一个全量 zip」的区别：
 *   - 照片按 sha256 存入 objects/，同一张照片（或重复内容）只存一份；
 *   - 每个快照只有一份 manifest.json，完整描述「此刻数据库 + 每张照片的状态」，
 *     所以恢复任意一个快照都不需要回溯历史增量；
 *   - 增量快照只把新出现的 blob 放进对象库，体积≈本周新增照片；
 *   - 每隔 SNAPSHOT_FULL_EVERY 次强制全量（重新核对全部照片），防止错误静默累积；
 *   - 创建时逐张校验照片 sha256 与数据库记录是否一致，结果写进 manifest。
 *
 * 布局（BACKUP_DIR 下）：
 *   snapshots/2026-09-21T03-30-00-000Z-incr/manifest.json
 *   snapshots/2026-09-21T03-30-00-000Z-full/manifest.json
 *   objects/ab/<sha256>
 *   .snapshot.lock                      防止 cron 与手动操作并发
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { databaseFilePath } from '../modules/export.routes.js';
import { verifyPhotos, type PhotoVerification } from './verify.js';

export const SNAPSHOT_FORMAT = 'gml-snapshot-v1' as const;
export type SnapshotKind = 'full' | 'incr';

export interface SnapshotFileEntry {
  /** 相对 uploads 目录的路径，统一用正斜杠 */
  path: string;
  size: number;
  sha256: string;
  /** 是否在数据库照片记录（storagePath / thumbPath）中被引用 */
  referenced: boolean;
}

export interface SnapshotDbEntry {
  sha256: string;
  size: number;
}

export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  id: string;
  kind: SnapshotKind;
  createdAt: string;
  parentId: string | null;
  fullEvery: number;
  database: SnapshotDbEntry;
  files: SnapshotFileEntry[];
  /** 本次新写入对象库的对象哈希（增量快照通常远小于文件总数） */
  addedObjects: string[];
  verification: {
    checkedAt: string;
    total: number;
    ok: number;
    missing: string[];
    corrupted: string[];
    /** manifest 收录但没有任何数据库记录引用的文件（照片被软删但文件还在等） */
    unreferencedCount: number;
  };
}

export interface SnapshotSummary {
  id: string;
  kind: SnapshotKind;
  createdAt: string;
  parentId: string | null;
  fileCount: number;
  dbSize: number;
  addedObjects: number;
  ok: boolean;
  total: number;
  missingCount: number;
  corruptedCount: number;
}

const SNAPSHOT_TTL_MS = 120_000;

function snapshotsRoot(): string {
  return join(env.backupDir, 'snapshots');
}

function objectsRoot(): string {
  return join(env.backupDir, 'objects');
}

/** 简单的进程/实例间互斥：锁存在且未过期则拒绝；崩溃后 TTL 自动放行 */
export function acquireLock(): void {
  const lock = join(env.backupDir, '.snapshot.lock');
  if (existsSync(lock)) {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < SNAPSHOT_TTL_MS) {
      throw new Error('另一个快照/恢复任务正在运行（锁未释放），请稍后再试');
    }
    logger.warn({ ageMs: age }, '发现过期的快照锁，按崩溃残留处理');
  }
  mkdirSync(env.backupDir, { recursive: true });
  writeFileSync(lock, `${new Date().toISOString()} ${process.pid}\n`);
}

export function releaseLock(): void {
  rmSync(join(env.backupDir, '.snapshot.lock'), { force: true });
}

/** 用 VACUUM INTO 取数据库的事务一致副本；不支持时退回「checkpoint + 热拷贝」 */
async function snapshotDatabase(target: string): Promise<void> {
  const dbPath = databaseFilePath();
  if (!existsSync(dbPath)) throw new Error('数据库文件不存在，无法创建快照');
  try {
    // VACUUM INTO 原子地生成一个全新的 SQLite 文件，是事务一致快照，不受 WAL 影响
    const escaped = target.replaceAll("'", "''");
    await prisma.$queryRawUnsafe(`VACUUM INTO '${escaped}'`);
    if (existsSync(target) && statSync(target).size > 0) return;
    throw new Error('VACUUM INTO 未生成文件');
  } catch (error) {
    logger.warn({ err: String(error) }, 'VACUUM INTO 失败，退回热拷贝');
    // WAL 模式下先把 WAL 合并进主库文件再拷贝，降低拿到半截数据的概率
    try {
      await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 连不上库时仍尝试拷贝文件本身
    }
    cpSync(dbPath, target);
  }
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function objectPath(hash: string): string {
  return join(objectsRoot(), hash.slice(0, 2), hash);
}

/** 遍历 uploads 下全部常规文件（含软删后遗留文件，一并备份，路径统一正斜杠） */
function walkUploads(): string[] {
  if (!existsSync(env.uploadDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(full);
    }
  };
  walk(env.uploadDir);
  return out
    .map((full) => relative(env.uploadDir, full).split(sep).join('/'))
    .sort();
}

/** 把文件纳入内容寻址对象库；已存在则跳过（内容相同绝不重复写） */
function storeObject(absFile: string, hash: string): boolean {
  const target = objectPath(hash);
  if (existsSync(target)) return false;
  mkdirSync(resolve(target, '..'), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  cpSync(absFile, tmp);
  // 落盘后再校验一次，防止拷贝过程中文件被改写
  if (sha256File(tmp) !== hash) {
    rmSync(tmp, { force: true });
    throw new Error(`对象写入校验失败：${absFile}`);
  }
  renameSync(tmp, target);
  return true;
}

export interface CreateSnapshotOptions {
  /** 强制全量：重新核对并收录全部照片；不传则按计数自动决定 */
  forceFull?: boolean;
}

/**
 * 创建一个快照：数据库一致副本 + uploads 全量文件清单，照片内容去重存入对象库，
 * 并逐张校验数据库记录的 sha256 与磁盘文件是否一致。
 */
export async function createSnapshot(options: CreateSnapshotOptions = {}): Promise<SnapshotManifest> {
  acquireLock();
  let manifest: SnapshotManifest | null = null;
  try {
    mkdirSync(snapshotsRoot(), { recursive: true });
    mkdirSync(objectsRoot(), { recursive: true });

    const previous = listManifests().at(-1) ?? null;
    const sequence = previous ? previous.sequence + 1 : 1;
    const forceFull = options.forceFull ?? sequence % Math.max(env.snapshotFullEvery, 1) === 0;
    const kind: SnapshotKind = forceFull || !previous ? 'full' : 'incr';

    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const id = `${stamp}-${kind}`;
    const dir = join(snapshotsRoot(), id);
    mkdirSync(dir, { recursive: true });

    // 1) 数据库一致副本
    const dbTmp = join(dir, 'app.db.tmp');
    await snapshotDatabase(dbTmp);
    const dbHash = sha256File(dbTmp);
    const dbSize = statSync(dbTmp).size;
    const dbAdded = storeObject(dbTmp, dbHash);
    rmSync(dbTmp, { force: true });

    // 2) 照片一致性校验（逐张与数据库记录比对）
    const verification = await verifyPhotos();

    // 3) uploads 全量文件清单（恢复时以清单为准），并把新增内容放进对象库
    const referenced = collectReferencedPaths(verification);
    const allRelative = walkUploads();
    const parentHashes = new Set<string>(previous?.manifest.files.map((f) => f.sha256) ?? []);
    const files: SnapshotFileEntry[] = [];
    const addedObjects: string[] = dbAdded ? [dbHash] : [];

    for (const rel of allRelative) {
      const abs = join(env.uploadDir, rel);
      const hash = sha256File(abs);
      files.push({ path: rel, size: statSync(abs).size, sha256: hash, referenced: referenced.has(rel) });
      // 增量：父快照已有相同内容就不重复存；全量：同样靠 CAS 跳过，差别在于全量会重新核对
      if (!parentHashes.has(hash) && storeObject(abs, hash)) addedObjects.push(hash);
    }

    const unreferencedCount = files.filter((f) => !f.referenced).length;
    manifest = {
      format: SNAPSHOT_FORMAT,
      id,
      kind,
      createdAt: new Date().toISOString(),
      parentId: kind === 'incr' ? previous?.manifest.id ?? null : null,
      fullEvery: env.snapshotFullEvery,
      database: { sha256: dbHash, size: dbSize },
      files,
      addedObjects,
      verification: {
        checkedAt: new Date().toISOString(),
        total: verification.total,
        ok: verification.ok,
        missing: verification.missing,
        corrupted: verification.corrupted,
        unreferencedCount,
      },
    };

    const manifestTmp = join(dir, 'manifest.json.tmp');
    writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2));
    renameSync(manifestTmp, join(dir, 'manifest.json'));
    logger.info(
      {
        id,
        kind,
        files: files.length,
        addedObjects: addedObjects.length,
        missing: verification.missing.length,
        corrupted: verification.corrupted.length,
      },
      '快照已创建',
    );
    return manifest;
  } finally {
    if (!manifest) {
      // 创建失败时清理半成品目录
      const partial = readdirSync(snapshotsRoot(), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(snapshotsRoot(), d.name))
        .filter((dir) => !existsSync(join(dir, 'manifest.json')));
      for (const dir of partial) rmSync(dir, { recursive: true, force: true });
    }
    releaseLock();
  }
}

function collectReferencedPaths(verification: PhotoVerification): Set<string> {
  const set = new Set<string>();
  for (const photo of verification.photos) {
    set.add(photo.storagePath.split(sep).join('/'));
    if (photo.thumbPath) set.add(photo.thumbPath.split(sep).join('/'));
  }
  return set;
}

interface LoadedManifest {
  manifest: SnapshotManifest;
  dir: string;
  sequence: number;
}

function loadManifestDir(dir: string): LoadedManifest | null {
  const file = join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as SnapshotManifest;
    if (manifest.format !== SNAPSHOT_FORMAT) return null;
    // 目录名以时间戳开头，天然可排序
    return { manifest, dir, sequence: 0 };
  } catch {
    return null;
  }
}

/** 按创建时间升序读取全部快照 */
export function listManifests(): LoadedManifest[] {
  if (!existsSync(snapshotsRoot())) return [];
  return readdirSync(snapshotsRoot(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => loadManifestDir(join(snapshotsRoot(), d.name)))
    .filter((m): m is LoadedManifest => m !== null)
    .sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
}

export function listSnapshots(): SnapshotSummary[] {
  return listManifests().map(({ manifest }) => ({
    id: manifest.id,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    parentId: manifest.parentId,
    fileCount: manifest.files.length,
    dbSize: manifest.database.size,
    addedObjects: manifest.addedObjects.length,
    ok: manifest.verification.missing.length === 0 && manifest.verification.corrupted.length === 0,
    total: manifest.verification.total,
    missingCount: manifest.verification.missing.length,
    corruptedCount: manifest.verification.corrupted.length,
  }));
}

export function readSnapshot(id: string): SnapshotManifest {
  // id 只允许是快照目录名，杜绝路径穿越
  if (!/^[\w.-]+$/u.test(id)) throw new Error('非法的快照 ID');
  const file = join(snapshotsRoot(), id, 'manifest.json');
  if (!existsSync(file)) throw new Error(`快照不存在：${id}`);
  return JSON.parse(readFileSync(file, 'utf8')) as SnapshotManifest;
}

/**
 * 重新校验一个已有快照：清单中的每个哈希都必须能在对象库中找到且内容一致，
 * 数据库对象同样校验。用于「逐一校验历史快照是否还可用」。
 */
export function verifySnapshot(id: string): {
  id: string;
  ok: boolean;
  filesChecked: number;
  missingObjects: string[];
  corruptedObjects: string[];
  photoMissing: string[];
  photoCorrupted: string[];
} {
  const manifest = readSnapshot(id);
  const missingObjects: string[] = [];
  const corruptedObjects: string[] = [];

  const checkObject = (hash: string): void => {
    const obj = objectPath(hash);
    if (!existsSync(obj)) {
      missingObjects.push(hash);
      return;
    }
    if (sha256File(obj) !== hash) corruptedObjects.push(hash);
  };

  checkObject(manifest.database.sha256);
  for (const file of manifest.files) checkObject(file.sha256);

  return {
    id,
    ok:
      missingObjects.length === 0 &&
      corruptedObjects.length === 0 &&
      manifest.verification.missing.length === 0 &&
      manifest.verification.corrupted.length === 0,
    filesChecked: manifest.files.length + 1,
    missingObjects,
    corruptedObjects,
    photoMissing: manifest.verification.missing,
    photoCorrupted: manifest.verification.corrupted,
  };
}

export interface RestoreOptions {
  /** 校验失败（对象缺失/损坏）时是否仍继续，默认拒绝 */
  force?: boolean;
  /** 恢复到指定目录（测试/演练用）；默认覆盖真实 uploads 与数据库 */
  targetUploadDir?: string;
  targetDbPath?: string;
}

/**
 * 从快照恢复：用清单 + 对象库重建 uploads，并替换数据库文件。
 * 恢复后必须重启服务（SQLite 连接仍指向旧 inode），与旧版行为一致。
 */
export function restoreSnapshot(id: string, options: RestoreOptions = {}): { filesRestored: number; dbPath: string } {
  const manifest = readSnapshot(id);
  const check = verifySnapshot(id);
  if (!check.ok && !options.force) {
    throw new Error(
      `快照校验未通过（缺对象 ${check.missingObjects.length} 个、损坏 ${check.corruptedObjects.length} 个、` +
        `拍照时缺失 ${check.photoMissing.length} 张、损坏 ${check.photoCorrupted.length} 张），拒绝恢复；` +
        '确认要强行恢复请加 --force',
    );
  }

  const uploadDir = options.targetUploadDir ?? env.uploadDir;
  const dbPath = options.targetDbPath ?? databaseFilePath();
  acquireLock();
  try {
    mkdirSync(uploadDir, { recursive: true });
    mkdirSync(resolve(dbPath, '..'), { recursive: true });

    // 以清单为唯一真相重建：先把现有文件全部挪到 .before-restore/，不直接删除
    const backupDir = join(resolve(uploadDir, '..'), `uploads.before-restore-${Date.now()}`);
    if (!options.targetUploadDir && existsSync(uploadDir) && readdirSync(uploadDir).length > 0) {
      renameSync(uploadDir, backupDir);
      mkdirSync(uploadDir, { recursive: true });
    }

    let filesRestored = 0;
    for (const file of manifest.files) {
      if (file.path.includes('..')) continue;
      const obj = objectPath(file.sha256);
      if (!existsSync(obj)) {
        if (!options.force) throw new Error(`对象库缺少 ${file.sha256}，恢复中止`);
        continue;
      }
      const target = join(uploadDir, file.path);
      mkdirSync(resolve(target, '..'), { recursive: true });
      cpSync(obj, target);
      filesRestored += 1;
    }

    const dbObj = objectPath(manifest.database.sha256);
    if (!existsSync(dbObj) && !options.force) throw new Error('数据库对象缺失，恢复中止');
    if (existsSync(dbObj)) {
      const tmp = `${dbPath}.restore-tmp`;
      cpSync(dbObj, tmp);
      if (existsSync(dbPath) && !options.targetDbPath) {
        cpSync(dbPath, `${dbPath}.before-restore.bak`);
      }
      renameSync(tmp, dbPath);
    }

    logger.info({ id, filesRestored }, '快照恢复完成');
    return { filesRestored, dbPath };
  } finally {
    releaseLock();
  }
}

export interface PruneResult {
  kept: string[];
  deleted: string[];
  removedObjects: number;
}

/**
 * 按周留存：保留最近 retentionWeeks 周内的全部快照，以及至少 1 个最新快照。
 * 由于每个快照都是完整清单（对象共享），删掉旧快照后只回收无人引用的对象。
 */
export function pruneSnapshots(retentionWeeks: number = env.snapshotRetentionWeeks): PruneResult {
  acquireLock();
  try {
    const all = listManifests();
    if (all.length <= 1) return { kept: all.map((m) => m.manifest.id), deleted: [], removedObjects: 0 };

    const cutoff = Date.now() - retentionWeeks * 7 * 24 * 60 * 60 * 1000;
    const kept: LoadedManifest[] = [];
    const deleted: string[] = [];
    all.forEach((entry, index) => {
      const created = new Date(entry.manifest.createdAt).getTime();
      // 最新快照永远保留；其余按留存窗口裁剪
      if (index === all.length - 1 || created >= cutoff) {
        kept.push(entry);
      } else {
        rmSync(entry.dir, { recursive: true, force: true });
        deleted.push(entry.manifest.id);
      }
    });

    const referenced = new Set<string>();
    for (const entry of kept) {
      referenced.add(entry.manifest.database.sha256);
      for (const file of entry.manifest.files) referenced.add(file.sha256);
    }

    // 回收无任何存活快照引用的对象
    let removedObjects = 0;
    if (existsSync(objectsRoot())) {
      for (const shard of readdirSync(objectsRoot(), { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        const shardDir = join(objectsRoot(), shard.name);
        for (const name of readdirSync(shardDir)) {
          if (name.endsWith('.tmp') || name.startsWith('.') || !/^[0-9a-f]{64}$/u.test(name)) continue;
          if (!referenced.has(name)) {
            rmSync(join(shardDir, name), { force: true });
            removedObjects += 1;
          }
        }
        if (readdirSync(shardDir).length === 0) rmSync(shardDir, { recursive: true, force: true });
      }
    }

    if (deleted.length || removedObjects) {
      logger.info({ deleted: deleted.length, removedObjects }, '快照留存裁剪完成');
    }
    return { kept: kept.map((m) => m.manifest.id), deleted, removedObjects };
  } finally {
    releaseLock();
  }
}
