import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { HttpError } from './errors.js';

/** 从 DATABASE_URL 解析出 SQLite 文件路径（备份/快照/恢复共用） */
export function databaseFilePath(): string {
  const url = env.databaseUrl;
  if (url.startsWith('file:')) return resolve(url.slice(5));
  throw new HttpError('VALIDATION_FAILED', '当前数据库不是 SQLite 文件模式，请用 pg_dump 备份');
}
