const { createHash } = require('node:crypto')
const REMOTE_FOLDER = '客服宝'
const DEFAULT_URL = 'https://dav.jianguoyun.com/dav/'
const REMOTE_FILE = 'sync-v1.json'
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function entityKey(type, id) { return type + ':' + id }
function recordSignature(record) { return record ? JSON.stringify({ type: record.type, deleted: Boolean(record.deleted), value: record.value ?? null }) : '' }
function flattenLibrary(library) {
  const records = new Map()
  for (const category of library.categories) records.set(entityKey('category', category.id), { type: 'category', id: category.id, value: category })
  for (const phrase of library.phrases) records.set(entityKey('phrase', phrase.id), { type: 'phrase', id: phrase.id, value: phrase })
  return records
}
function nextVersion(record) { return Math.max(Date.now(), Number(record?.updatedAt ?? 0) + 1) }
function initializeEntries(library, deviceId) {
  let version = Date.now()
  return Object.fromEntries([...flattenLibrary(library)].map(([key, record]) => [key, { ...record, deleted: false, updatedAt: version++, deviceId }]))
}
function trackLocalLibrary(library, state, deviceId) {
  const current = flattenLibrary(library)
  if (!state.initialized || !state.entries) return { ...state, initialized: true, entries: initializeEntries(library, deviceId) }
  const entries = clone(state.entries)
  for (const [key, record] of current) {
    const existing = entries[key]
    if (!existing || existing.deleted || recordSignature(existing) !== recordSignature(record)) entries[key] = { ...record, deleted: false, updatedAt: nextVersion(existing), deviceId }
  }
  for (const [key, existing] of Object.entries(entries)) {
    if (existing && !existing.deleted && !current.has(key)) {
      entries[key] = existing.type === 'phrase'
        ? { type: existing.type, id: existing.id, deleted: true, updatedAt: nextVersion(existing), deviceId }
        : { ...existing, deleted: true, updatedAt: nextVersion(existing), deviceId }
    }
  }
  return { ...state, initialized: true, entries }
}
function compareVersions(left, right) {
  const difference = Number(left?.updatedAt ?? 0) - Number(right?.updatedAt ?? 0)
  if (difference) return difference
  const deviceDifference = String(left?.deviceId ?? '').localeCompare(String(right?.deviceId ?? ''))
  return deviceDifference || recordSignature(left).localeCompare(recordSignature(right))
}
function conflictId(key, record) {
  return 'sync-conflict-' + createHash('sha256').update(key + '\n' + recordSignature(record)).digest('hex').slice(0, 18)
}
function addPhraseConflict(entries, key, losingRecord) {
  if (losingRecord?.type !== 'phrase' || losingRecord.deleted || !losingRecord.value) return false
  const id = conflictId(key, losingRecord)
  const duplicateKey = entityKey('phrase', id)
  if (entries[duplicateKey]) return false
  const original = losingRecord.value
  const suffix = '（同步冲突副本）'
  entries[duplicateKey] = { ...losingRecord, id, value: {
    ...original, id, title: String(original.title ?? '未命名话术').replace(/（同步冲突副本）$/, '') + suffix,
    tags: [...new Set([...(Array.isArray(original.tags) ? original.tags : []), '同步冲突'])],
  } }
  return true
}
function mergeEntries(localEntries, remoteEntries, baseline, deviceId) {
  const merged = {}
  const baseEntries = baseline ?? {}
  const keys = new Set([...Object.keys(localEntries ?? {}), ...Object.keys(remoteEntries ?? {}), ...Object.keys(baseEntries)])
  let conflictCount = 0
  for (const key of keys) {
    const local = localEntries?.[key]
    const remote = remoteEntries?.[key]
    const base = baseEntries[key]
    const localChanged = recordSignature(local) !== recordSignature(base)
    const remoteChanged = recordSignature(remote) !== recordSignature(base)
    if (local && remote && recordSignature(local) !== recordSignature(remote) && localChanged && remoteChanged) {
      if (local.deleted !== remote.deleted) {
        const winner = local.deleted ? remote : local
        const deleted = local.deleted ? local : remote
        merged[key] = winner
        const archived = base?.type === 'phrase' && !base.deleted
          ? base
          : deleted.value ? { ...deleted, deleted: false } : null
        if (winner.type === 'phrase' && archived) {
          if (addPhraseConflict(merged, key, archived)) conflictCount += 1
        }
      }
      else {
        const winner = compareVersions(local, remote) >= 0 ? local : remote
        merged[key] = winner
        if (winner.type === 'phrase' && addPhraseConflict(merged, key, winner === local ? remote : local)) conflictCount += 1
      }
    } else if (localChanged && local) merged[key] = local
    else if (remoteChanged && remote) merged[key] = remote
    else if (base) merged[key] = base
    else if (local || remote) merged[key] = !local ? remote : !remote ? local : compareVersions(local, remote) >= 0 ? local : remote
  }
  for (const record of Object.values(merged)) {
    if (record.type === 'phrase' && record.deleted) delete record.value
  }
  return { entries: merged, conflictCount }
}
function mergeCloudPrimaryEntries(localEntries, remoteEntries, baseline, remoteExists) {
  const merged = {}
  const baseEntries = baseline ?? {}
  const hasBaseline = baseline !== null && baseline !== undefined
  const keys = new Set([...Object.keys(localEntries ?? {}), ...Object.keys(remoteEntries ?? {}), ...Object.keys(baseEntries)])
  let conflictCount = 0
  for (const key of keys) {
    const local = localEntries?.[key]
    const remote = remoteEntries?.[key]
    const base = baseEntries[key]
    const localChanged = recordSignature(local) !== recordSignature(base)
    const remoteChanged = recordSignature(remote) !== recordSignature(base)
    if (remoteExists && !hasBaseline) {
      if (remote) merged[key] = remote
      if (localChanged && recordSignature(local) !== recordSignature(remote)) conflictCount += 1
    } else if (remoteChanged) {
      if (remote) merged[key] = remote
      if (localChanged && recordSignature(local) !== recordSignature(remote)) conflictCount += 1
    } else if (localChanged) {
      if (local) merged[key] = local
    } else if (remote || base || local) {
      merged[key] = remote ?? base ?? local
    }
  }
  for (const record of Object.values(merged)) {
    if (record.type === 'phrase' && record.deleted) delete record.value
  }
  return { entries: merged, conflictCount }
}
function restoreMissingCategories(entries, deviceId) {
  const categories = new Set(Object.values(entries).filter((item) => item.type === 'category' && !item.deleted).map((item) => item.id))
  for (const record of Object.values(entries)) {
    if (record.type !== 'phrase' || record.deleted || !record.value || categories.has(record.value.categoryId)) continue
    const oldId = record.value.categoryId
    const old = entries[entityKey('category', oldId)]?.value
    const id = 'sync-restored-' + createHash('sha256').update(String(oldId)).digest('hex').slice(0, 12)
    const key = entityKey('category', id)
    if (!entries[key]) entries[key] = { type: 'category', id, deleted: false, updatedAt: Date.now(), deviceId, value: {
      id, name: String(old?.name ?? '已删除分类') + '（同步恢复）',
      scope: old?.scope === 'company' || old?.scope === 'group' ? old.scope : 'private', color: old?.color ?? '#758b9d',
    } }
    record.value = { ...record.value, categoryId: id }
    categories.add(id)
  }
}
function buildLibrary(entries, localLibrary) {
  const categories = Object.values(entries).filter((item) => item.type === 'category' && !item.deleted).map((item) => item.value)
  const phrases = Object.values(entries).filter((item) => item.type === 'phrase' && !item.deleted).map((item) => item.value)
  function order(records, previous, newestFirst) {
    const byId = new Map(records.map((item) => [item.id, item]))
    const ordered = (previous ?? []).map((item) => byId.get(item.id)).filter(Boolean)
    for (const item of ordered) byId.delete(item.id)
    const extras = [...byId.values()]
    if (newestFirst) extras.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    return ordered.concat(extras)
  }
  return { categories: order(categories, localLibrary?.categories, false), phrases: order(phrases, localLibrary?.phrases, true) }
}
function sameEntries(left, right) {
  const stable = (value) => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))))
  return stable(left) === stable(right)
}
function validRemoteEntries(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false
  return Object.entries(entries).every(([key, record]) => {
    if (!record || (record.type !== 'phrase' && record.type !== 'category') || typeof record.id !== 'string' || key !== entityKey(record.type, record.id)) return false
    if (typeof record.deleted !== 'boolean' || !Number.isFinite(record.updatedAt)) return false
    if (record.deleted && record.type === 'phrase' && record.value === undefined) return true
    const value = record.value
    if (!value || typeof value !== 'object' || value.id !== record.id) return false
    if (record.type === 'category') return typeof value.name === 'string' && typeof value.color === 'string' && ['company', 'group', 'private'].includes(value.scope)
    const validVideos = !value.videos || Array.isArray(value.videos) && value.videos.every((video) => video && typeof video.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(video.id) && typeof video.name === 'string' && typeof video.mime === 'string' && video.mime.startsWith('video/') && Number.isFinite(video.size) && video.size > 0 && video.size <= 50 * 1024 * 1024 && typeof video.sha256 === 'string' && /^[a-f0-9]{64}$/.test(video.sha256))
    return typeof value.title === 'string' && typeof value.text === 'string' && typeof value.categoryId === 'string' && Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string') && (!value.images || Array.isArray(value.images) && value.images.every((image) => typeof image === 'string')) && validVideos
  })
}
function normalizeBaseUrl(value) {
  let url
  try { url = new URL(String(value || DEFAULT_URL).trim()) }
  catch { throw new Error('WebDAV 地址格式不正确') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('WebDAV 地址需使用 HTTPS，且不能包含账号、密码或查询参数')
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url.toString()
}
function createWebDavClient(config) {
  const baseUrl = normalizeBaseUrl(config.url)
  const username = String(config.username ?? '').trim()
  const password = String(config.password ?? '')
  if (!username || !password) throw new Error('请填写坚果云账号和第三方应用密码')
  const authorization = 'Basic ' + Buffer.from(username + ':' + password, 'utf8').toString('base64')
  const folderUrl = new URL(encodeURIComponent(REMOTE_FOLDER) + '/', baseUrl).toString()
  const fileUrl = new URL(encodeURIComponent(REMOTE_FILE), folderUrl).toString()
  const videosFolderUrl = new URL('videos/', folderUrl).toString()
  async function request(url, method, headers = {}, body, timeout = 25000) {
    let response
    try { response = await fetch(url, { method, headers: { Authorization: authorization, ...headers }, body, signal: AbortSignal.timeout(timeout) }) }
    catch (error) {
      if (error?.name === 'TimeoutError') throw new Error('坚果云连接超时，请检查网络后重试')
      throw new Error('无法连接坚果云，请检查网络和 WebDAV 地址')
    }
    if (response.status === 401 || response.status === 403) throw new Error('坚果云验证失败，请检查账号和第三方应用密码')
    return response
  }
  async function prepareFolder() {
    const probe = await request(baseUrl, 'PROPFIND', { Depth: '0' })
    if (![200, 207].includes(probe.status)) throw new Error('WebDAV 验证失败（HTTP ' + probe.status + '）')
    const created = await request(folderUrl, 'MKCOL')
    if (![201, 405].includes(created.status)) throw new Error('无法创建坚果云同步目录（HTTP ' + created.status + '）')
    const videos = await request(videosFolderUrl, 'MKCOL')
    if (![201, 405].includes(videos.status)) throw new Error('无法创建坚果云视频目录（HTTP ' + videos.status + '）')
  }
  async function getDocument() {
    const response = await request(fileUrl, 'GET')
    if (response.status === 404) return { document: null, etag: null }
    if (!response.ok) throw new Error('读取坚果云同步文件失败（HTTP ' + response.status + '）')
    let document
    try { document = await response.json() }
    catch { throw new Error('坚果云同步文件无法解析，请勿手动覆盖') }
    if (document?.schemaVersion !== 1 || !validRemoteEntries(document.entries) || (document.ownerDeviceId !== undefined && (typeof document.ownerDeviceId !== 'string' || !document.ownerDeviceId.trim()))) throw new Error('坚果云同步文件版本或数据格式不兼容，请勿手动覆盖')
    return { document, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') }
  }
  async function checkFolder() {
    const root = await request(baseUrl, 'PROPFIND', { Depth: '0' })
    if (![200, 207].includes(root.status)) throw new Error('坚果云连接验证失败（HTTP ' + root.status + '）')
    const folder = await request(folderUrl, 'PROPFIND', { Depth: '0' })
    if (folder.status === 404) throw new Error('坚果云同步目录不存在，请先在主电脑连接并初始化同步')
    if (![200, 207].includes(folder.status)) throw new Error('无法读取坚果云同步目录（HTTP ' + folder.status + '）')
    return true
  }
  async function putDocument(document, etag, exists, lastModified) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    if (etag) headers['If-Match'] = etag
    else if (exists && lastModified) headers['If-Unmodified-Since'] = lastModified
    else if (!exists) headers['If-None-Match'] = '*'
    const response = await request(fileUrl, 'PUT', headers, JSON.stringify(document))
    if (response.status === 412) return false
    if (![200, 201, 204].includes(response.status)) throw new Error('写入坚果云同步文件失败（HTTP ' + response.status + '）')
    return true
  }
  async function hasVideo(id) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(id))) throw new Error('视频附件标识无效')
    const response = await request(new URL(encodeURIComponent(id), videosFolderUrl).toString(), 'PROPFIND', { Depth: '0' })
    if (response.status === 404) return false
    if (response.ok || response.status === 207) return true
    throw new Error('检查坚果云视频附件失败（HTTP ' + response.status + '）')
  }
  async function getVideo(id) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(id))) throw new Error('视频附件标识无效')
    const response = await request(new URL(encodeURIComponent(id), videosFolderUrl).toString(), 'GET', {}, undefined, 120000)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('下载坚果云视频附件失败（HTTP ' + response.status + '）')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('坚果云视频附件大小超出支持范围')
    return bytes
  }
  async function putVideo(id, bytes) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(id))) throw new Error('视频附件标识无效')
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('视频附件大小超出支持范围')
    const response = await request(new URL(encodeURIComponent(id), videosFolderUrl).toString(), 'PUT', { 'Content-Type': 'application/octet-stream' }, bytes, 120000)
    if (![200, 201, 204].includes(response.status)) throw new Error('上传坚果云视频附件失败（HTTP ' + response.status + '）')
    return true
  }
  async function removeVideo(id) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(id))) throw new Error('视频附件标识无效')
    const response = await request(new URL(encodeURIComponent(id), videosFolderUrl).toString(), 'DELETE')
    if (response.status === 404 || [200, 202, 204].includes(response.status)) return true
    throw new Error('删除坚果云视频附件失败（HTTP ' + response.status + '）')
  }
  return { prepareFolder, getDocument, putDocument, checkFolder, hasVideo, getVideo, putVideo, removeVideo }
}
module.exports = { DEFAULT_URL, REMOTE_FOLDER, buildLibrary, createWebDavClient, initializeEntries, mergeCloudPrimaryEntries, mergeEntries, normalizeBaseUrl, recordSignature, restoreMissingCategories, sameEntries, trackLocalLibrary, validRemoteEntries }
