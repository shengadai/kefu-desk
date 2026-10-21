import { Preferences } from '@capacitor/preferences'
import sha256 from 'js-sha256'
import type { Category, LibraryData, Phrase, VideoAttachment } from './types'

const DEFAULT_URL = 'https://dav.jianguoyun.com/dav/'
const REMOTE_FOLDER = '客服宝'
const REMOTE_FILE = 'sync-v1.json'
const SYNC_STATE_FILE = 'android-sync-state.json'
const SETTINGS_KEY = 'android-cloud-sync-settings'

type RecordValue = { type: 'category' | 'phrase'; id: string; value?: Category | Phrase; deleted: boolean; updatedAt: number; deviceId: string }
type SyncState = { deviceId: string; initialized: boolean; entries: Record<string, RecordValue>; baseline: Record<string, RecordValue> | null; remoteScope?: string; ownerDeviceId?: string | null }
type SyncConfig = { configured: boolean; url: string; username: string; deviceRole: 'primary' | 'readonly'; lastSyncAt: number | null }
export type MobileSyncStatus = { configured: boolean; syncing: boolean; lastSyncAt: number | null; conflictCount?: number; error: string; message?: string; deviceRole: 'local' | 'primary' | 'readonly'; canEdit: boolean }
type SyncDocument = { schemaVersion: number; updatedAt: number; deviceId: string; ownerDeviceId?: string; entries: Record<string, RecordValue> }

const defaultConfig: SyncConfig = { configured: false, url: DEFAULT_URL, username: '', deviceRole: 'readonly', lastSyncAt: null }
let syncStatus: MobileSyncStatus = { configured: false, syncing: false, lastSyncAt: null, error: '', deviceRole: 'local', canEdit: true }
let syncTask: Promise<MobileSyncStatus> | null = null
let scheduledSync: ReturnType<typeof setTimeout> | undefined
let suppressAutoSync = false
const statusListeners = new Set<(status: MobileSyncStatus) => void>()
const libraryListeners = new Set<(update: { workspace: 'local' | 'cloud'; value: string }) => void>()

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function entryKey(type: 'category' | 'phrase', id: string) { return `${type}:${id}` }
function signature(record?: RecordValue) { return record ? JSON.stringify({ type: record.type, deleted: Boolean(record.deleted), value: record.value ?? null }) : '' }

function flattenLibrary(library: LibraryData) {
  const records = new Map<string, Omit<RecordValue, 'deleted' | 'updatedAt' | 'deviceId'>>()
  for (const category of library.categories) records.set(entryKey('category', category.id), { type: 'category', id: category.id, value: category })
  for (const phrase of library.phrases) records.set(entryKey('phrase', phrase.id), { type: 'phrase', id: phrase.id, value: phrase })
  return records
}

function initializeEntries(library: LibraryData, deviceId: string) {
  let version = Date.now()
  return Object.fromEntries([...flattenLibrary(library)].map(([key, record]) => [key, { ...record, deleted: false, updatedAt: version++, deviceId }])) as Record<string, RecordValue>
}

function trackLocalLibrary(library: LibraryData, state: SyncState, deviceId: string) {
  const current = flattenLibrary(library)
  if (!state.initialized || !state.entries) return { ...state, initialized: true, entries: initializeEntries(library, deviceId) }
  const entries = clone(state.entries)
  for (const [key, record] of current) {
    const existing = entries[key]
    if (!existing || existing.deleted || signature(existing) !== signature(record as RecordValue)) {
      entries[key] = { ...record, deleted: false, updatedAt: Math.max(Date.now(), Number(existing?.updatedAt ?? 0) + 1), deviceId } as RecordValue
    }
  }
  for (const [key, existing] of Object.entries(entries)) {
    if (existing && !existing.deleted && !current.has(key)) {
      entries[key] = existing.type === 'phrase'
        ? { type: existing.type, id: existing.id, deleted: true, updatedAt: Math.max(Date.now(), existing.updatedAt + 1), deviceId }
        : { ...existing, deleted: true, updatedAt: Math.max(Date.now(), existing.updatedAt + 1), deviceId }
    }
  }
  return { ...state, initialized: true, entries }
}

function mergeCloudPrimaryEntries(localEntries: Record<string, RecordValue>, remoteEntries: Record<string, RecordValue>, baseline: Record<string, RecordValue> | null, remoteExists: boolean) {
  const merged: Record<string, RecordValue> = {}
  const baseEntries = baseline ?? {}
  const keys = new Set([...Object.keys(localEntries ?? {}), ...Object.keys(remoteEntries ?? {}), ...Object.keys(baseEntries)])
  let conflictCount = 0
  for (const key of keys) {
    const local = localEntries?.[key]
    const remote = remoteEntries?.[key]
    const base = baseEntries[key]
    const localChanged = signature(local) !== signature(base)
    const remoteChanged = signature(remote) !== signature(base)
    if (remoteExists && baseline === null) {
      if (remote) merged[key] = remote
      if (localChanged && signature(local) !== signature(remote)) conflictCount += 1
    } else if (remoteChanged) {
      if (remote) merged[key] = remote
      if (localChanged && signature(local) !== signature(remote)) conflictCount += 1
    } else if (localChanged) {
      if (local) merged[key] = local
    } else if (remote || base || local) merged[key] = remote ?? base ?? local!
  }
  for (const record of Object.values(merged)) if (record.type === 'phrase' && record.deleted) delete record.value
  return { entries: merged, conflictCount }
}

function restoreMissingCategories(entries: Record<string, RecordValue>, deviceId: string) {
  const categories = new Set(Object.values(entries).filter((item) => item.type === 'category' && !item.deleted).map((item) => item.id))
  for (const record of Object.values(entries)) {
    if (record.type !== 'phrase' || record.deleted || !record.value || categories.has((record.value as Phrase).categoryId)) continue
    const phrase = record.value as Phrase
    const oldId = phrase.categoryId
    const old = entries[entryKey('category', oldId)]?.value as Category | undefined
    const id = `sync-restored-${sha256(oldId).slice(0, 12)}`
    const key = entryKey('category', id)
    if (!entries[key]) entries[key] = { type: 'category', id, deleted: false, updatedAt: Date.now(), deviceId, value: {
      id,
      name: `${String(old?.name ?? '已删除分类')}（同步恢复）`,
      scope: old?.scope === 'company' || old?.scope === 'group' ? old.scope : 'private',
      color: old?.color ?? '#758b9d',
    } }
    record.value = { ...phrase, categoryId: id }
    categories.add(id)
  }
}

function buildLibrary(entries: Record<string, RecordValue>, previous?: LibraryData | null): LibraryData {
  const categories = Object.values(entries).filter((entry) => entry.type === 'category' && !entry.deleted).map((entry) => entry.value as Category)
  const phrases = Object.values(entries).filter((entry) => entry.type === 'phrase' && !entry.deleted).map((entry) => entry.value as Phrase)
  function order<T extends { id: string; updatedAt?: number }>(records: T[], oldRecords: T[] | undefined, newestFirst: boolean) {
    const byId = new Map(records.map((record) => [record.id, record]))
    const ordered = (oldRecords ?? []).map((record) => byId.get(record.id)).filter((record): record is T => Boolean(record))
    for (const record of ordered) byId.delete(record.id)
    const extras = [...byId.values()]
    if (newestFirst) extras.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    return ordered.concat(extras)
  }
  return { categories: order(categories, previous?.categories, false), phrases: order(phrases, previous?.phrases, true) }
}

function sameEntries(left: Record<string, RecordValue> = {}, right: Record<string, RecordValue> = {}) {
  const stable = (value: Record<string, RecordValue>) => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))))
  return stable(left) === stable(right)
}

function validRemoteEntries(entries: unknown): entries is Record<string, RecordValue> {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false
  return Object.entries(entries).every(([key, record]) => {
    if (!record || (record.type !== 'phrase' && record.type !== 'category') || typeof record.id !== 'string' || key !== entryKey(record.type, record.id)) return false
    if (typeof record.deleted !== 'boolean' || !Number.isFinite(record.updatedAt)) return false
    if (record.deleted && record.type === 'phrase' && record.value === undefined) return true
    const value = record.value as Category | Phrase | undefined
    if (!value || typeof value !== 'object' || value.id !== record.id) return false
    if (record.type === 'category') return typeof (value as Category).name === 'string' && typeof (value as Category).color === 'string' && ['company', 'group', 'private'].includes((value as Category).scope)
    const phrase = value as Phrase
    const validVideos = !phrase.videos || Array.isArray(phrase.videos) && phrase.videos.every((video: VideoAttachment) => video && typeof video.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(video.id) && typeof video.name === 'string' && typeof video.mime === 'string' && video.mime.startsWith('video/') && Number.isFinite(video.size) && video.size > 0 && video.size <= 50 * 1024 * 1024 && typeof video.sha256 === 'string' && /^[a-f0-9]{64}$/.test(video.sha256))
    return typeof phrase.title === 'string' && typeof phrase.text === 'string' && typeof phrase.categoryId === 'string' && Array.isArray(phrase.tags) && phrase.tags.every((tag) => typeof tag === 'string') && (!phrase.images || Array.isArray(phrase.images) && phrase.images.every((image) => typeof image === 'string')) && validVideos
  })
}

function normalizeBaseUrl(value: string) {
  let url: URL
  try { url = new URL(String(value || DEFAULT_URL).trim()) } catch { throw new Error('WebDAV 地址格式不正确') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('WebDAV 地址需使用 HTTPS，且不能包含账号、密码或查询参数')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.toString()
}

function basicAuth(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

function createWebDavClient(config: { url: string; username: string; password: string }) {
  const baseUrl = normalizeBaseUrl(config.url)
  const username = String(config.username ?? '').trim()
  const password = String(config.password ?? '')
  if (!username || !password) throw new Error('请填写坚果云账号和第三方应用密码')
  const authorization = basicAuth(`${username}:${password}`)
  const folderUrl = new URL(`${encodeURIComponent(REMOTE_FOLDER)}/`, baseUrl).toString()
  const fileUrl = new URL(encodeURIComponent(REMOTE_FILE), folderUrl).toString()
  const videosFolderUrl = new URL('videos/', folderUrl).toString()
  async function request(url: string, method: string, headers: Record<string, string> = {}, body?: BodyInit | null, timeout = 25000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let response: Response
    try {
      response = await fetch(url, { method, headers: { Authorization: authorization, ...headers }, body, signal: controller.signal })
    } catch {
      throw new Error('无法连接坚果云，请检查网络和 WebDAV 地址')
    } finally { clearTimeout(timer) }
    if (response.status === 401 || response.status === 403) throw new Error('坚果云验证失败，请检查账号和第三方应用密码')
    return response
  }
  async function prepareFolder() {
    const probe = await request(baseUrl, 'PROPFIND', { Depth: '0' })
    if (![200, 207].includes(probe.status)) throw new Error(`WebDAV 验证失败（HTTP ${probe.status}）`)
    const created = await request(folderUrl, 'MKCOL')
    if (![201, 405].includes(created.status)) throw new Error(`无法创建坚果云同步目录（HTTP ${created.status}）`)
    const videos = await request(videosFolderUrl, 'MKCOL')
    if (![201, 405].includes(videos.status)) throw new Error(`无法创建坚果云视频目录（HTTP ${videos.status}）`)
  }
  async function getDocument() {
    const response = await request(fileUrl, 'GET')
    if (response.status === 404) return { document: null as SyncDocument | null, etag: null as string | null, lastModified: null as string | null }
    if (!response.ok) throw new Error(`读取坚果云同步文件失败（HTTP ${response.status}）`)
    let document: SyncDocument
    try { document = await response.json() as SyncDocument } catch { throw new Error('坚果云同步文件无法解析，请勿手动覆盖') }
    if (document?.schemaVersion !== 1 || !validRemoteEntries(document.entries) || (document.ownerDeviceId !== undefined && (typeof document.ownerDeviceId !== 'string' || !document.ownerDeviceId.trim()))) throw new Error('坚果云同步文件版本或数据格式不兼容，请勿手动覆盖')
    return { document, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') }
  }
  async function checkFolder() {
    const root = await request(baseUrl, 'PROPFIND', { Depth: '0' })
    if (![200, 207].includes(root.status)) throw new Error(`坚果云连接验证失败（HTTP ${root.status}）`)
    const folder = await request(folderUrl, 'PROPFIND', { Depth: '0' })
    if (folder.status === 404) throw new Error('坚果云同步目录不存在，请先在主电脑连接并初始化同步')
    if (![200, 207].includes(folder.status)) throw new Error(`无法读取坚果云同步目录（HTTP ${folder.status}）`)
  }
  async function putDocument(document: SyncDocument, etag: string | null, exists: boolean, lastModified: string | null) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (etag) headers['If-Match'] = etag
    else if (exists && lastModified) headers['If-Unmodified-Since'] = lastModified
    else if (!exists) headers['If-None-Match'] = '*'
    const response = await request(fileUrl, 'PUT', headers, JSON.stringify(document))
    if (response.status === 412) return false
    if (![200, 201, 204].includes(response.status)) throw new Error(`写入坚果云同步文件失败（HTTP ${response.status}）`)
    return true
  }
  return { prepareFolder, getDocument, putDocument, checkFolder }
}

async function readAppFile(name: string) {
  const result = await window.kefuAndroid!.readAppFile({ name })
  return result.value
}

async function writeAppFile(name: string, value: string) {
  await window.kefuAndroid!.writeAppFile({ name, value })
}

async function readSyncState(): Promise<SyncState> {
  const raw = await readAppFile(SYNC_STATE_FILE)
  if (!raw) return { deviceId: crypto.randomUUID(), initialized: false, entries: {}, baseline: null }
  let stored: Partial<SyncState>
  try { stored = JSON.parse(raw) as Partial<SyncState> } catch { throw new Error('本机同步状态无法读取，请先导出话术备份') }
  const snapshot = stored.entries ?? stored.baseline ?? {}
  return { deviceId: stored.deviceId || crypto.randomUUID(), initialized: Boolean(stored.initialized), entries: snapshot, baseline: stored.baseline ?? snapshot, remoteScope: stored.remoteScope, ownerDeviceId: stored.ownerDeviceId }
}

async function writeSyncState(state: SyncState) {
  await writeAppFile(SYNC_STATE_FILE, JSON.stringify({ ...state, entries: state.entries ?? state.baseline ?? {} }))
}

async function getConfig(): Promise<SyncConfig> {
  const { value } = await Preferences.get({ key: SETTINGS_KEY })
  if (!value) return { ...defaultConfig }
  try {
    const config = { ...defaultConfig, ...(JSON.parse(value) as Partial<SyncConfig>), configured: true }
    if (config.deviceRole !== 'readonly') {
      config.deviceRole = 'readonly'
      await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(config) })
    }
    return config
  } catch { return { ...defaultConfig } }
}

function publishStatus(value: Partial<MobileSyncStatus>) {
  syncStatus = { ...syncStatus, ...value }
  for (const listener of statusListeners) listener(syncStatus)
  return syncStatus
}

export function onMobileSyncStatus(listener: (status: MobileSyncStatus) => void) {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

export function onMobileLibraryUpdated(listener: (update: { workspace: 'local' | 'cloud'; value: string }) => void) {
  libraryListeners.add(listener)
  return () => libraryListeners.delete(listener)
}

export function publishMobileLibraryUpdate(value: string) {
  for (const listener of libraryListeners) listener({ workspace: 'cloud', value })
}

async function cloudAccess(settings: SyncConfig) {
  if (!settings.configured) return { configured: false, deviceRole: 'local' as const, canEdit: true }
  return { configured: true, deviceRole: 'readonly' as const, canEdit: false }
}

async function credential() {
  const config = await getConfig()
  if (!config.configured) return null
  const { value: password } = await window.kefuAndroid!.getSecret()
  if (!password) throw new Error('坚果云密码未保存，请重新连接坚果云')
  return { config, password }
}

async function saveCloudLibrary(library: LibraryData) {
  suppressAutoSync = true
  try {
    const value = JSON.stringify(library)
    await window.kefuAndroid!.writeCloudLibraryCache({ value })
    publishMobileLibraryUpdate(value)
  } finally { suppressAutoSync = false }
}

async function runSyncInternal(): Promise<MobileSyncStatus> {
  const storedCredential = await credential()
  if (!storedCredential) return publishStatus({ configured: false, syncing: false, error: '', deviceRole: 'local', canEdit: true })
  const { config, password } = storedCredential
  const requestedRole = 'readonly'
  publishStatus({ configured: true, syncing: true, error: '', message: '正在连接坚果云', deviceRole: requestedRole, canEdit: false })
  try {
    const state = await readSyncState()
    const currentScope = `${normalizeBaseUrl(config.url)}\n${config.username.trim().toLocaleLowerCase()}`
    const raw = await window.kefuAndroid!.readLibrary({ workspace: 'cloud' }).then((result) => result.value)
    let localLibrary: LibraryData | null = null
    if (raw) {
      try { localLibrary = JSON.parse(raw) as LibraryData } catch { throw new Error('本机话术库无法解析，已暂停云同步') }
      if (!Array.isArray(localLibrary.categories) || !Array.isArray(localLibrary.phrases)) throw new Error('本机话术库格式不正确，已暂停云同步')
    }
    const scopeChanged = Boolean(state.remoteScope && state.remoteScope !== currentScope)
    if (scopeChanged && raw) await writeAppFile(`cloud-backup-${Date.now()}.json`, raw)
    const activeState: SyncState = scopeChanged
      ? { deviceId: state.deviceId || crypto.randomUUID(), initialized: false, entries: {}, baseline: null, remoteScope: currentScope, ownerDeviceId: null }
      : { ...state, remoteScope: currentScope }
    const syncLibrary = scopeChanged ? null : localLibrary
    const client = createWebDavClient({ url: config.url, username: config.username, password })
    if (requestedRole === 'readonly') await client.checkFolder()
    else await client.prepareFolder()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const remote = await client.getDocument()
      if (!remote.document && !scopeChanged && activeState.initialized && activeState.remoteScope === currentScope) {
        if (raw) await writeAppFile(`cloud-backup-remote-missing-${Date.now()}.json`, raw)
        throw new Error('坚果云云端主库文件不存在，已暂停同步以防本机缓存覆盖云端；本机缓存已保留。')
      }
      const remoteOwner = remote.document?.ownerDeviceId ?? null
      if (remoteOwner && (remoteOwner !== activeState.deviceId || requestedRole === 'readonly')) {
        if (remoteOwner !== activeState.ownerDeviceId) {
          activeState.ownerDeviceId = remoteOwner
          await writeSyncState(activeState)
        }
        publishStatus({ configured: true, syncing: true, error: '', message: '正在下载主设备内容（只读）', deviceRole: 'readonly', canEdit: false })
        const remoteLibrary = buildLibrary(remote.document!.entries)
        const remoteRaw = JSON.stringify(remoteLibrary)
        if (raw && (state.remoteScope !== currentScope || state.ownerDeviceId !== remoteOwner) && raw !== remoteRaw) await writeAppFile(`cloud-backup-before-readonly-${Date.now()}.json`, raw)
        if (remoteRaw !== raw) await saveCloudLibrary(remoteLibrary)
        const snapshot = clone(remote.document!.entries)
        await writeSyncState({ ...activeState, initialized: true, entries: snapshot, baseline: snapshot, remoteScope: currentScope, ownerDeviceId: remoteOwner })
        const lastSyncAt = Date.now()
        const saved = { ...config, lastSyncAt }
        await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(saved) })
        return publishStatus({ configured: true, syncing: false, lastSyncAt, error: '', message: '已同步主设备内容，只读模式', deviceRole: 'readonly', canEdit: false })
      }
      if (requestedRole === 'readonly') throw new Error('坚果云主设备尚未初始化，请先在主电脑完成首次同步')
      const localState = syncLibrary ? trackLocalLibrary(syncLibrary, activeState, activeState.deviceId) : activeState
      const merged = mergeCloudPrimaryEntries(localState.entries ?? {}, remote.document?.entries ?? {}, localState.baseline, Boolean(remote.document))
      restoreMissingCategories(merged.entries, localState.deviceId)
      const mergedLibrary = buildLibrary(merged.entries, syncLibrary)
      const mergedRaw = JSON.stringify(mergedLibrary)
      if (merged.conflictCount > 0 && raw && mergedRaw !== raw) await writeAppFile(`cloud-backup-conflict-${Date.now()}.json`, raw)
      const document: SyncDocument = { schemaVersion: 1, updatedAt: Date.now(), deviceId: localState.deviceId, ownerDeviceId: localState.deviceId, entries: merged.entries }
      const ownershipChanged = !remote.document?.ownerDeviceId
      if ((ownershipChanged || !sameEntries(merged.entries, remote.document?.entries)) && !await client.putDocument(document, remote.etag, Boolean(remote.document), remote.lastModified)) continue
      if (mergedRaw !== raw) await saveCloudLibrary(mergedLibrary)
      const snapshot = clone(merged.entries)
      await writeSyncState({ ...localState, initialized: true, entries: snapshot, baseline: snapshot, remoteScope: currentScope, ownerDeviceId: localState.deviceId })
      const lastSyncAt = Date.now()
      await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify({ ...config, lastSyncAt }) })
      return publishStatus({ configured: true, syncing: false, lastSyncAt, conflictCount: merged.conflictCount, error: '', message: merged.conflictCount ? `已以坚果云为准完成同步，发现 ${merged.conflictCount} 处冲突` : '云端优先同步完成', deviceRole: 'readonly', canEdit: false })
    }
    throw new Error('云端数据正在被其他设备更新，请稍后重试')
  } catch (error) {
    const access = await cloudAccess(config)
    return publishStatus({ syncing: false, ...access, error: error instanceof Error ? error.message : '同步失败', message: '同步失败' })
  }
}

export function runMobileSync() {
  if (syncTask) return syncTask
  syncTask = runSyncInternal().finally(() => { syncTask = null })
  return syncTask
}

export async function configureMobileSync(value: { url: string; username: string; password: string; deviceRole: 'primary' | 'readonly' }) {
  const previous = await getConfig()
  const password = String(value.password || '').trim() || (await window.kefuAndroid!.getSecret()).value || ''
  if (!password) throw new Error('请填写坚果云第三方应用密码')
  const url = normalizeBaseUrl(value.url || DEFAULT_URL)
  const username = String(value.username ?? '').trim()
  if (!username) throw new Error('请填写坚果云账号邮箱')
  const deviceRole = 'readonly'
  const client = createWebDavClient({ url, username, password })
  if (deviceRole === 'readonly') await client.checkFolder()
  else await client.prepareFolder()
  await window.kefuAndroid!.setSecret({ value: password })
  const config: SyncConfig = { ...previous, configured: true, url, username, deviceRole }
  await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(config) })
  publishStatus({ configured: true, syncing: false, error: '', deviceRole, canEdit: false })
  return runMobileSync()
}

export async function getMobileSyncConfig() { return getConfig() }

export async function getMobileSyncStatus() {
  const config = await getConfig()
  if (config.configured) return runMobileSync()
  return publishStatus({ configured: false, syncing: false, error: '', deviceRole: 'local', canEdit: true })
}

export async function disconnectMobileSync() {
  await Preferences.remove({ key: SETTINGS_KEY })
  await window.kefuAndroid!.removeSecret()
  if (scheduledSync) clearTimeout(scheduledSync)
  scheduledSync = undefined
  return publishStatus({ configured: false, syncing: false, error: '', message: '已断开云同步', deviceRole: 'local', canEdit: true })
}

export function scheduleMobileSync() {
  if (suppressAutoSync || scheduledSync) return
  scheduledSync = setTimeout(() => {
    scheduledSync = undefined
    void getConfig().then((config) => config.configured ? runMobileSync() : null).catch((error) => {
      publishStatus({ ...syncStatus, syncing: false, error: error instanceof Error ? error.message : '同步失败' })
    })
  }, 1000)
}
