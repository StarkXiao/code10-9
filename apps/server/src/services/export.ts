/**
 * 导出与打印（项目文档 9.9 / F19 / F20）。
 * 不引入 PDF 库：用 Markdown / CSV / 打印样式 HTML，浏览器直接"打印成 PDF"。
 */
import {
  DAMAGE_STATUS_LABEL,
  DISPOSITION_LABEL,
  GARMENT_CATEGORY_LABEL,
  GARMENT_STATUS_LABEL,
  MATERIAL_PRIMARY_LABEL,
  KNIT_OR_WOVEN_LABEL,
  PHOTO_VIEW_LABEL,
  REPAIR_STATUS_LABEL,
  STITCH_LABEL,
  VERDICT_LABEL,
  WEAR_FREQUENCY_BAND_LABEL,
  DAMAGE_TYPE_LABEL,
  SEVERITY_LABEL,
  type DamageStatus,
  type Disposition,
  type GarmentCategory,
  type GarmentStatus,
  type KnitOrWoven,
  type MaterialPrimary,
  type PhotoView,
  type RepairStatus,
  type Severity,
  type StitchCode,
  type Verdict,
} from '@gml/shared';
import { prisma } from '../lib/prisma.js';
import { formatDateOnly } from '../lib/date.js';
import { computeHealth, loadDataset, computeAllGarmentStats } from './stats.js';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function dateOrDash(value: Date | null | undefined): string {
  return value ? formatDateOnly(value) : '—';
}

export async function garmentMarkdown(garmentId: string): Promise<string | null> {
  const garment = await prisma.garment.findFirst({
    where: { id: garmentId, deletedAt: null },
    include: {
      photos: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
      damageEvents: {
        orderBy: { detectedAt: 'asc' },
        include: {
          damageType: true,
          part: true,
          repairs: {
            orderBy: { round: 'asc' },
            include: { change: true, stitch: true, materials: { include: { fabricSource: true } }, reviews: true },
          },
        },
      },
      wearLogs: { orderBy: { wornOn: 'asc' } },
    },
  });
  if (!garment) return null;

  const dataset = await loadDataset(garment.wardrobeId, { includeRetired: true });
  const stats = computeAllGarmentStats(dataset).get(garmentId);
  const health = stats ? computeHealth(stats) : null;

  const lines: string[] = [];
  lines.push(`# ${garment.name}（${garment.code}）`);
  lines.push('');
  lines.push(`- 品类：${GARMENT_CATEGORY_LABEL[garment.category as GarmentCategory] ?? garment.category}`);
  lines.push(`- 材质：${MATERIAL_PRIMARY_LABEL[garment.materialPrimary as MaterialPrimary] ?? garment.materialPrimary}（${KNIT_OR_WOVEN_LABEL[garment.knitOrWoven as KnitOrWoven] ?? garment.knitOrWoven}）`);
  lines.push(`- 季节：${(Array.isArray(garment.seasonTags) ? (garment.seasonTags as string[]) : []).join('、')}`);
  lines.push(`- 状态：${GARMENT_STATUS_LABEL[garment.status as GarmentStatus] ?? garment.status}`);
  lines.push(`- 购入：${dateOrDash(garment.purchaseDate)}${garment.purchasePrice ? ` · ${garment.purchasePrice.toString()} 元` : ''}`);
  if (garment.retiredAt) {
    lines.push(
      `- 退役：${dateOrDash(garment.retiredAt)} · ${DISPOSITION_LABEL[garment.disposition as Disposition] ?? garment.disposition ?? '—'}`,
    );
  }
  lines.push('');

  if (stats) {
    lines.push('## 长期使用统计');
    lines.push('');
    lines.push(`- 穿着次数：${stats.wearCount} 次（近 30 天 ${stats.wearCountLast30} 次）`);
    lines.push(`- 月均频率：${stats.perMonth} 次/月（${WEAR_FREQUENCY_BAND_LABEL[stats.frequencyBand]}）`);
    lines.push(`- 服役天数：${stats.serviceDays} 天`);
    lines.push(`- 修补次数：${stats.repairCount} 次`);
    lines.push(`- 复修率：${(stats.recurrenceRate * 100).toFixed(0)}%（复发 ${stats.recurrenceCount} 次 / 已修补 ${stats.repairedEventCount} 次）`);
    lines.push(`- 每穿成本：${stats.costPerWear ?? '—'} 元`);
    if (health) lines.push(`- 健康分：${health.score}（${health.advice}）`);
    lines.push('');
  }

  if (garment.photos.length > 0) {
    lines.push('## 照片');
    lines.push('');
    for (const photo of garment.photos) {
      lines.push(`- ${PHOTO_VIEW_LABEL[photo.view as PhotoView] ?? photo.view}：${photo.storagePath}`);
    }
    lines.push('');
  }

  lines.push('## 破损与修补历史');
  lines.push('');
  if (garment.damageEvents.length === 0) {
    lines.push('（暂无记录）');
  }
  for (const damage of garment.damageEvents) {
    lines.push(
      `### ${damage.code} · ${damage.damageType.name} · ${SEVERITY_LABEL[damage.severity as Severity] ?? damage.severity}`,
    );
    lines.push('');
    lines.push(
      `- 发现：${dateOrDash(damage.detectedAt)} · 部位 ${damage.part?.name ?? '未标注'} · 状态 ${DAMAGE_STATUS_LABEL[damage.status as DamageStatus] ?? damage.status}`,
    );
    if (damage.recurrenceOf) lines.push(`- 复发链：第 ${damage.recurrenceIndex ?? '?'} 次（原始事件 ${damage.recurrenceOf}）`);
    if (damage.description) lines.push(`- 描述：${damage.description}`);
    for (const repair of damage.repairs) {
      lines.push('');
      lines.push(`#### 第 ${repair.round} 轮修补 · ${repair.stitch.name}`);
      lines.push('');
      lines.push(
        `- 完成：${dateOrDash(repair.finishedAt)} · 观察期至 ${dateOrDash(repair.observationUntil)} · 状态 ${REPAIR_STATUS_LABEL[repair.status as RepairStatus] ?? repair.status}`,
      );
      if (repair.materials.length > 0) {
        lines.push(`- 用料：${repair.materials.map((m) => `${m.fabricSource.name} ${m.amount}${unitLabel(m.unit)}`).join('、')}`);
      }
      if (repair.change) {
        lines.push(
          `- 修补后变化：痕迹 ${repair.change.visibility}、颜色 ${repair.change.colorMatch}、手感 ${repair.change.stiffness}${repair.change.comfortNote ? `、体感：${repair.change.comfortNote}` : ''}`,
        );
      }
      for (const review of repair.reviews) {
        lines.push(
          `- 复检 ${dateOrDash(review.reviewedAt)}：${VERDICT_LABEL[review.verdict as Verdict] ?? review.verdict}（${review.daysSinceRepair} 天后）${review.verdictNote ? ` — ${review.verdictNote}` : ''}`,
        );
      }
    }
    lines.push('');
  }

  lines.push('## 穿着记录');
  lines.push('');
  if (garment.wearLogs.length === 0) lines.push('（暂无记录）');
  else lines.push(garment.wearLogs.map((w) => formatDateOnly(w.wornOn)).join('、'));
  lines.push('');
  return lines.join('\n');
}

function unitLabel(unit: string): string {
  return unit === 'cm2' ? 'cm²' : unit === 'cm' ? 'cm' : '片';
}

export async function wardrobeCsv(wardrobeId: string, datasetName: string): Promise<string | null> {
  const garmentIds = (
    await prisma.garment.findMany({ where: { wardrobeId, deletedAt: null }, select: { id: true } })
  ).map((g) => g.id);
  if (garmentIds.length === 0 && datasetName !== 'garments') return null;

  if (datasetName === 'garments') {
    const garments = await prisma.garment.findMany({
      where: { wardrobeId, deletedAt: null },
      orderBy: { code: 'asc' },
    });
    const header = ['编号', '名称', '品类', '主材质', '针织/梭织', '季节', '状态', '购入日期', '购入价', '首次穿着', '健康分'];
    const rows = garments.map((g) => [
      g.code,
      g.name,
      GARMENT_CATEGORY_LABEL[g.category as GarmentCategory] ?? g.category,
      MATERIAL_PRIMARY_LABEL[g.materialPrimary as MaterialPrimary] ?? g.materialPrimary,
      KNIT_OR_WOVEN_LABEL[g.knitOrWoven as KnitOrWoven] ?? g.knitOrWoven,
      (Array.isArray(g.seasonTags) ? (g.seasonTags as string[]) : []).join('/'),
      GARMENT_STATUS_LABEL[g.status as GarmentStatus] ?? g.status,
      dateOrDash(g.purchaseDate),
      g.purchasePrice?.toString() ?? '',
      dateOrDash(g.firstWearDate),
      g.healthScore ?? '',
    ]);
    return toCsv(header, rows);
  }

  if (datasetName === 'damages') {
    const damages = await prisma.damageEvent.findMany({
      where: { garmentId: { in: garmentIds } },
      include: { garment: true, damageType: true, part: true },
      orderBy: { detectedAt: 'asc' },
    });
    const header = ['衣物编号', '破损编号', '类型', '严重度', '部位', '发现日期', '状态', '是否复发', '复发序号', '描述'];
    const rows = damages.map((d) => [
      d.garment.code,
      d.code,
      d.damageType.name,
      SEVERITY_LABEL[d.severity as Severity] ?? d.severity,
      d.part?.name ?? '',
      dateOrDash(d.detectedAt),
      DAMAGE_STATUS_LABEL[d.status as DamageStatus] ?? d.status,
      d.recurrenceOf ? '是' : '否',
      d.recurrenceIndex ?? '',
      d.description ?? '',
    ]);
    return toCsv(header, rows);
  }

  if (datasetName === 'repairs') {
    const repairs = await prisma.repair.findMany({
      where: { damageEvent: { garmentId: { in: garmentIds } } },
      include: {
        damageEvent: { include: { garment: true } },
        stitch: true,
        change: true,
        reviews: true,
        materials: true,
      },
      orderBy: { finishedAt: 'asc' },
    });
    const header = [
      '衣物编号', '破损编号', '轮次', '针法', '执行方', '开始', '完成', '观察期至', '状态',
      '费用', '痕迹等级', '颜色匹配', '手感', '复检结论', '复检日期',
    ];
    const rows = repairs.map((r) => {
      const lastReview = r.reviews.at(-1);
      return [
        r.damageEvent.garment.code,
        r.damageEvent.code,
        String(r.round),
        r.stitch.name,
        r.executedBy,
        dateOrDash(r.startedAt),
        dateOrDash(r.finishedAt),
        dateOrDash(r.observationUntil),
        REPAIR_STATUS_LABEL[r.status as RepairStatus] ?? r.status,
        r.cost?.toString() ?? r.shopCost?.toString() ?? '',
        r.change?.visibility ?? '',
        r.change?.colorMatch ?? '',
        r.change?.stiffness ?? '',
        lastReview ? VERDICT_LABEL[lastReview.verdict as Verdict] ?? lastReview.verdict : '',
        lastReview ? dateOrDash(lastReview.reviewedAt) : '',
      ];
    });
    return toCsv(header, rows);
  }

  if (datasetName === 'wears') {
    const wears = await prisma.wearLog.findMany({
      where: { garmentId: { in: garmentIds } },
      include: { garment: true },
      orderBy: { wornOn: 'asc' },
    });
    const header = ['衣物编号', '衣物名称', '穿着日期', '时长档', '季节', '场合', '强度', '备注'];
    const rows = wears.map((w) => [
      w.garment.code,
      w.garment.name,
      dateOrDash(w.wornOn),
      w.session,
      w.seasonSnapshot,
      w.occasion ?? '',
      w.intensity,
      w.note ?? '',
    ]);
    return toCsv(header, rows);
  }

  return null;
}

function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  const escapeCell = (value: string | number) => {
    const text = String(value ?? '');
    return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  return [header.map(escapeCell).join(','), ...rows.map((row) => row.map(escapeCell).join(','))].join('\n');
}

const PRINT_STYLE = `
:root { color-scheme: light; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; color: #1f2328; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 24px 0 8px; border-left: 3px solid #c2410c; padding-left: 8px; }
.muted { color: #6b7280; font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; font-size: 13px; }
.card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.photos { display: flex; flex-wrap: wrap; gap: 12px; }
.photo { width: 220px; }
.photo img { width: 100%; border: 1px solid #e5e7eb; border-radius: 6px; }
.marker { display: inline-block; padding: 0 6px; border-radius: 9999px; background: #fee2e2; color: #9a3412; font-size: 12px; margin-right: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
th { background: #f9fafb; }
@media print { body { padding: 0; } .no-print { display: none; } }
`;

export async function printGarmentHtml(garmentId: string, opts: { token?: string } = {}): Promise<string | null> {
  const garment = await prisma.garment.findFirst({
    where: { id: garmentId, deletedAt: null },
    include: {
      photos: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { annotations: { include: { part: true, damageEvent: { include: { damageType: true } } } } },
      },
      damageEvents: {
        orderBy: { detectedAt: 'asc' },
        include: { damageType: true, part: true, repairs: { include: { stitch: true, change: true, reviews: true } } },
      },
    },
  });
  if (!garment) return null;

  const tokenParam = opts.token ? `?token=${encodeURIComponent(opts.token)}` : '';
  const photoBlocks = garment.photos
    .map((photo) => {
      const markers = photo.annotations
        .map(
          (annotation) =>
            `<span class="marker">${esc(annotation.part?.name ?? '未标部位')} · ${esc(annotation.damageEvent?.damageType.name ?? '标记')}${
              annotation.label ? ` · ${esc(annotation.label)}` : ''
            }</span>`,
        )
        .join('');
      return `<div class="photo"><img src="/api/photos/${photo.id}/file${tokenParam}" alt="${esc(
        PHOTO_VIEW_LABEL[photo.view as PhotoView] ?? photo.view,
      )}" /><div class="muted">${esc(PHOTO_VIEW_LABEL[photo.view as PhotoView] ?? photo.view)}</div><div>${markers}</div></div>`;
    })
    .join('');

  const history = garment.damageEvents
    .map((damage) => {
      const repairs = damage.repairs
        .map(
          (repair) => `<tr>
            <td>${repair.round}</td>
            <td>${esc(repair.stitch.name)}</td>
            <td>${dateOrDash(repair.finishedAt)}</td>
            <td>${esc(REPAIR_STATUS_LABEL[repair.status as RepairStatus] ?? repair.status)}</td>
            <td>${esc(repair.change?.visibility ?? '—')} / ${esc(repair.change?.colorMatch ?? '—')}</td>
            <td>${repair.reviews.length ? `${esc(VERDICT_LABEL[repair.reviews.at(-1)!.verdict as Verdict] ?? '')} @ ${dateOrDash(repair.reviews.at(-1)!.reviewedAt)}` : '未复检'}</td>
          </tr>`,
        )
        .join('');
      return `<div class="card">
        <strong>${esc(damage.code)} · ${esc(damage.damageType.name)} · ${esc(
          SEVERITY_LABEL[damage.severity as Severity] ?? damage.severity,
        )}</strong>
        <div class="muted">发现 ${dateOrDash(damage.detectedAt)} · 部位 ${esc(damage.part?.name ?? '未标注')} · 状态 ${esc(
          DAMAGE_STATUS_LABEL[damage.status as DamageStatus] ?? damage.status,
        )}${damage.recurrenceOf ? ' · 复发' : ''}</div>
        ${damage.description ? `<div>${esc(damage.description)}</div>` : ''}
        ${
          repairs
            ? `<table><thead><tr><th>轮次</th><th>针法</th><th>完成</th><th>状态</th><th>变化</th><th>复检</th></tr></thead><tbody>${repairs}</tbody></table>`
            : '<div class="muted">尚未修补</div>'
        }
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>${esc(garment.name)} · 衣物档案</title><style>${PRINT_STYLE}</style></head>
<body>
  <h1>${esc(garment.name)} <span class="muted">${esc(garment.code)}</span></h1>
  <div class="muted">打印时间 ${new Date().toLocaleString('zh-CN')}</div>
  <div class="grid">
    <div>品类：${esc(GARMENT_CATEGORY_LABEL[garment.category as GarmentCategory] ?? garment.category)}</div>
    <div>材质：${esc(MATERIAL_PRIMARY_LABEL[garment.materialPrimary as MaterialPrimary] ?? garment.materialPrimary)}</div>
    <div>结构：${esc(KNIT_OR_WOVEN_LABEL[garment.knitOrWoven as KnitOrWoven] ?? garment.knitOrWoven)}</div>
    <div>状态：${esc(GARMENT_STATUS_LABEL[garment.status as GarmentStatus] ?? garment.status)}</div>
    <div>购入：${dateOrDash(garment.purchaseDate)}</div>
    <div>首次穿着：${dateOrDash(garment.firstWearDate)}</div>
    <div>收纳：${esc(garment.storageLocation ?? '—')}</div>
    <div>洗护：${esc(garment.careNote ?? '—')}</div>
  </div>
  ${garment.photos.length ? `<h2>照片与标记</h2><div class="photos">${photoBlocks}</div>` : ''}
  <h2>破损与修补历史</h2>
  ${history || '<div class="muted">暂无记录</div>'}
  <div class="no-print" style="margin-top:24px">
    <button onclick="window.print()">打印 / 另存为 PDF</button>
  </div>
</body></html>`;
}

export async function printWorksheetHtml(damageEventId: string, opts: { token?: string } = {}): Promise<string | null> {
  const damage = await prisma.damageEvent.findUnique({
    where: { id: damageEventId },
    include: {
      garment: true,
      damageType: true,
      part: true,
      annotations: { include: { photo: true } },
      repairs: { include: { stitch: true } },
    },
  });
  if (!damage) return null;

  const tokenParam = opts.token ? `?token=${encodeURIComponent(opts.token)}` : '';
  const photo = damage.annotations[0]?.photo;
  const geometry = damage.annotations[0]?.geometry as { x?: number; y?: number } | undefined;
  const markerBox = photo && geometry && typeof geometry.x === 'number' && typeof geometry.y === 'number'
    ? `<div class="muted">标记坐标（归一化，原点左上）：x=${geometry.x.toFixed(4)}, y=${(geometry.y ?? 0).toFixed(4)} → 像素 (${Math.round(
        geometry.x * photo.width,
      )}, ${Math.round((geometry.y ?? 0) * photo.height)})，原图 ${photo.width}×${photo.height}</div>`
    : '';

  const lastRepair = damage.repairs.at(-1);

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>修补工单 ${esc(damage.code)}</title><style>${PRINT_STYLE}</style></head>
<body>
  <h1>修补工单 <span class="muted">${esc(damage.code)}</span></h1>
  <div class="muted">${esc(damage.garment.name)}（${esc(damage.garment.code)}） · 打印于 ${new Date().toLocaleString('zh-CN')}</div>
  <h2>需要修什么</h2>
  <div class="grid">
    <div>破损类型：${esc(damage.damageType.name)}</div>
    <div>严重度：${esc(SEVERITY_LABEL[damage.severity as Severity] ?? damage.severity)}</div>
    <div>部位：${esc(damage.part?.name ?? '见下图标记')}</div>
    <div>发现日期：${dateOrDash(damage.detectedAt)}</div>
    <div>材质：${esc(MATERIAL_PRIMARY_LABEL[damage.garment.materialPrimary as MaterialPrimary] ?? damage.garment.materialPrimary)}</div>
    <div>结构：${esc(KNIT_OR_WOVEN_LABEL[damage.garment.knitOrWoven as KnitOrWoven] ?? damage.garment.knitOrWoven)}</div>
  </div>
  ${damage.description ? `<p>${esc(damage.description)}</p>` : ''}
  ${damage.measurableSize ? `<p class="muted">实测尺寸：${esc(JSON.stringify(damage.measurableSize))}</p>` : ''}
  <h2>位置</h2>
  ${photo ? `<div class="photo"><img src="/api/photos/${photo.id}/file${tokenParam}" alt="破损位置" /><div class="muted">${esc(
    PHOTO_VIEW_LABEL[photo.view as PhotoView] ?? photo.view,
  )}</div></div>${markerBox}` : '<div class="muted">未提供照片标记</div>'}
  <h2>建议</h2>
  <div>${(Array.isArray(damage.damageType.suggestedStitchCodes) ? (damage.damageType.suggestedStitchCodes as string[]) : [])
    .map((code) => `<span class="marker">${esc(STITCH_LABEL[code as StitchCode] ?? code)}</span>`)
    .join('')}
    <div class="muted">${
      damage.garment.knitOrWoven === 'knit'
        ? '针织类：优先顺着线圈织补，不要用熨烫贴合补。'
        : '梭织类：可外侧贴布 + 内侧加固衬布。'
    }</div>
  </div>
  ${
    lastRepair
      ? `<h2>上一次怎么修的</h2><div>第 ${lastRepair.round} 轮 · ${esc(lastRepair.stitch.name)} · 完成 ${dateOrDash(lastRepair.finishedAt)}</div>`
      : ''
  }
  <h2>修完请记录</h2>
  <table><thead><tr><th>实际针法</th><th>用料</th><th>耗时</th><th>费用</th><th>备注</th></tr></thead>
  <tbody><tr><td style="height:32px"></td><td></td><td></td><td></td><td></td></tr></tbody></table>
  <div class="no-print" style="margin-top:24px"><button onclick="window.print()">打印 / 另存为 PDF</button></div>
</body></html>`;
}

export function damageTypeName(code: string): string {
  return DAMAGE_TYPE_LABEL[code as keyof typeof DAMAGE_TYPE_LABEL] ?? code;
}

/**
 * 业务数据 JSON 全量导出（备份 zip 与增量快照共用同一份口径）。
 * 指定 wardrobeId 时只导出该衣橱的数据。
 */
export async function collectExportData(wardrobeId?: string): Promise<Record<string, unknown>> {
  const where = wardrobeId ? { wardrobeId } : {};
  const [garments, damages, repairs, wears, reviews, fabricSources, reminders, dictionary] = await Promise.all([
    prisma.garment.findMany({ where }),
    prisma.damageEvent.findMany({ where: { garment: where } }),
    prisma.repair.findMany({ where: { damageEvent: { garment: where } } }),
    prisma.wearLog.findMany({ where: { garment: where } }),
    prisma.reviewResult.findMany({ where: { repair: { damageEvent: { garment: where } } } }),
    prisma.fabricSource.findMany({ where }),
    prisma.reminder.findMany({ where }),
    prisma.stitch.findMany(),
  ]);
  return { exportedAt: new Date().toISOString(), wardrobeId: wardrobeId ?? null, garments, damages, repairs, wears, reviews, fabricSources, reminders, dictionary };
}
