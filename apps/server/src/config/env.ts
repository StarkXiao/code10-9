import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
export const serverRoot = resolve(here, '../..');
export const repoRoot = resolve(serverRoot, '../..');

for (const candidate of [resolve(repoRoot, '.env'), resolve(serverRoot, '.env')]) {
  if (existsSync(candidate)) dotenv.config({ path: candidate });
}

function abs(value: string): string {
  return isAbsolute(value) ? value : resolve(serverRoot, value);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  /**
   * 对外访问来源。留空时按请求自动推断（见 lib/origin.ts），
   * 这样开发（5173）与单端口生产（同源）都不用手工改配置。
   */
  webOrigin: process.env.WEB_ORIGIN ?? '',
  timezone: process.env.TZ ?? 'Asia/Shanghai',
  databaseUrl: process.env.DATABASE_URL ?? `file:${resolve(serverRoot, 'data/app.db')}`,
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  shareLinkTtlHours: int(process.env.SHARE_LINK_TTL_HOURS, 72),
  uploadDir: abs(process.env.UPLOAD_DIR ?? './data/uploads'),
  backupDir: abs(process.env.BACKUP_DIR ?? './data/backup'),
  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 20),
  cronEnabled: (process.env.CRON_ENABLED ?? 'true') !== 'false',
  cronSchedule: process.env.CRON_SCHEDULE ?? '0 * * * *',
  /** 增量快照：每周自动留存一份，只复制新增照片（内容寻址去重） */
  snapshotEnabled: (process.env.SNAPSHOT_ENABLED ?? 'true') !== 'false',
  snapshotCron: process.env.SNAPSHOT_CRON ?? '40 3 * * 0',
  snapshotKeepWeeks: int(process.env.SNAPSHOT_KEEP_WEEKS, 8),
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'mending-log@localhost',
  webhookUrl: process.env.WEBHOOK_URL ?? '',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
};

export const maxUploadBytes = env.maxUploadMb * 1024 * 1024;
