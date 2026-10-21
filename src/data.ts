import type { LibraryData, ShortcutModifier, VideoAttachment } from './types'

export const starterLibrary: LibraryData = {
  categories: [
    { id: 'welcome', name: '欢迎接待', scope: 'company', color: '#6d9cf5' },
    { id: 'orders', name: '订单物流', scope: 'company', color: '#4bb99a' },
    { id: 'product', name: '商品咨询', scope: 'company', color: '#ed9b56' },
    { id: 'aftercare', name: '售后处理', scope: 'group', color: '#dd7d88' },
    { id: 'personal', name: '我的常用', scope: 'private', color: '#9580db' },
  ],
  phrases: [
    { id: 'p1', title: '欢迎光临', text: '您好，欢迎光临～很高兴为您服务！请问有什么可以帮您？', categoryId: 'welcome', tags: ['欢迎', '接待'], shortcut: '1', favorite: true, updatedAt: Date.now() - 1000 * 60 * 4 },
    { id: 'p2', title: '正在为您查询', text: '好的，请稍等一下，我这边马上为您查询，预计 1–2 分钟回复您。', categoryId: 'welcome', tags: ['查询', '等待'], shortcut: '2', updatedAt: Date.now() - 1000 * 60 * 22 },
    { id: 'p3', title: '活动优惠说明', text: '亲，活动优惠会在订单结算时自动抵扣，您可以先将商品加入购物车查看最终价格哦。', categoryId: 'product', tags: ['优惠', '活动'], updatedAt: Date.now() - 1000 * 60 * 50 },
    { id: 'p4', title: '发货时间说明', text: '正常情况下，下单后 24 小时内安排发出。发货后您可以在订单详情页查看物流信息。', categoryId: 'orders', tags: ['发货', '物流'], updatedAt: Date.now() - 1000 * 60 * 60 * 3 },
    { id: 'p5', title: '物流进度跟进', text: '亲，已经帮您联系物流核实配送进度啦，有最新消息我会第一时间告诉您，请您放心。', categoryId: 'orders', tags: ['物流', '跟进'], favorite: true, updatedAt: Date.now() - 1000 * 60 * 60 * 7 },
    { id: 'p6', title: '退换货指引', text: '如果商品符合退换条件，请在订单页面申请售后并选择对应原因。提交后我们会尽快为您处理。', categoryId: 'aftercare', tags: ['退货', '换货', '售后'], updatedAt: Date.now() - 1000 * 60 * 60 * 20 },
    { id: 'p7', title: '感谢您的理解', text: '感谢您的耐心与理解，给您带来不便我们深表歉意。后续有任何问题，随时联系我就好。', categoryId: 'personal', tags: ['致歉', '感谢'], updatedAt: Date.now() - 1000 * 60 * 60 * 29 },
  ],
}

function normalizeImages(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

function normalizeVideos(value: unknown): VideoAttachment[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is VideoAttachment => Boolean(
    item && typeof item === 'object' &&
    typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(item.id) &&
    typeof item.name === 'string' && item.name.length > 0 &&
    typeof item.mime === 'string' && item.mime.startsWith('video/') &&
    typeof item.size === 'number' && Number.isFinite(item.size) && item.size > 0 && item.size <= 50 * 1024 * 1024 &&
    typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256),
  ))
}

export function normalizeLibrary(value: unknown): LibraryData | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<LibraryData>
  if (!Array.isArray(candidate.categories) || !Array.isArray(candidate.phrases)) return null
  const categories = candidate.categories.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
  const categoryIds = new Set(categories.map((category) => category.id))
  const phrases = candidate.phrases
    .filter((item) => item && typeof item.id === 'string' && categoryIds.has(item.categoryId))
    .map((item) => {
      const record = item as unknown as Record<string, unknown>
      const videos = normalizeVideos(record.videos)
      return {
        id: item.id,
        title: typeof record.title === 'string' ? record.title : '',
        text: typeof record.text === 'string' ? record.text : '',
        categoryId: item.categoryId,
        tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        images: normalizeImages(record.images ?? record.image),
        videos: videos.length ? videos : undefined,
        shortcut: typeof record.shortcut === 'string' ? record.shortcut : undefined,
        shortcutModifier: (record.shortcutModifier === 'ctrl' ? 'ctrl' : 'alt') as ShortcutModifier,
        favorite: record.favorite === true,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
      }
    })
  return { categories, phrases }
}
