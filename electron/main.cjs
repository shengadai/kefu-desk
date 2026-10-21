const { app, BrowserWindow, ClipboardItem, clipboard, globalShortcut, ipcMain, nativeImage, safeStorage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const { createHash, randomUUID } = require('node:crypto')
const { DEFAULT_URL, buildLibrary, createWebDavClient, mergeCloudPrimaryEntries, normalizeBaseUrl, restoreMissingCategories, sameEntries, trackLocalLibrary } = require('./cloud-sync.cjs')

let mainWindow
let overlayWindow
const storePath = (workspace = 'local') => path.join(app.getPath('userData'), workspace === 'cloud' ? 'cloud-library.json' : 'library.json')
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
const syncStatePath = () => path.join(app.getPath('userData'), 'sync-state.json')
const videoStorePath = (workspace, id, name) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(id ?? ''))) throw new Error('视频附件标识无效')
  const extension = path.extname(String(name ?? '').split(/[\\/]/).pop()).toLocaleLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ''
  return path.join(app.getPath('userData'), 'video-assets', workspace === 'cloud' ? 'cloud' : 'local', `${id}${safeExtension}`)
}
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
let dataQueue = Promise.resolve()
let syncTimer
let syncStatus = { configured: false, syncing: false, lastSyncAt: null, error: '', deviceRole: 'local', canEdit: true }
function clone(value) { return JSON.parse(JSON.stringify(value)) }

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true })
  const temporaryPath = `${settingsPath()}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(settings), 'utf8')
  await fs.rename(temporaryPath, settingsPath())
}

function getAutoLaunchEnabled() {
  const settings = app.getLoginItemSettings({ path: process.execPath, args: [] })
  return Boolean(settings.executableWillLaunchAtLogin ?? settings.openAtLogin)
}

function setAutoLaunchRegistration(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, enabled, name: app.getName(), path: process.execPath, args: [] })
  return getAutoLaunchEnabled()
}

async function readLibrary(workspace = 'local') {
  try {
    return await fs.readFile(storePath(workspace), 'utf8')
  } catch {
    return null
  }
}

async function writeLibrary(value, workspace = 'local') {
  const targetPath = storePath(workspace)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, value, 'utf8')
  await fs.rename(temporaryPath, targetPath)
  return true
}
async function readVideoAsset(workspace, id, name) {
  const storedPath = videoStorePath(workspace, id, name)
  try {
    const stat = await fs.stat(storedPath)
    if (!stat.isFile() || stat.size > MAX_VIDEO_BYTES) throw new Error('视频附件大小异常')
    return await fs.readFile(storedPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
async function statVideoAsset(workspace, id, name) {
  try {
    const stat = await fs.stat(videoStorePath(workspace, id, name))
    return stat.isFile() ? stat : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
async function writeVideoAsset(workspace, id, name, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_VIDEO_BYTES) throw new Error('视频附件必须大于 0 且不超过 50 MB')
  const storedPath = videoStorePath(workspace, id, name)
  await fs.mkdir(path.dirname(storedPath), { recursive: true })
  const temporaryPath = `${storedPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporaryPath, bytes)
  await fs.rename(temporaryPath, storedPath)
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
async function downloadCloudVideoAsset(id, name, expectedSize, expectedSha256) {
  const credential = await readSyncCredential()
  if (!credential) return null
  const client = createWebDavClient(credential)
  const bytes = await client.getVideo(id)
  if (!bytes) return null
  if (bytes.length !== expectedSize) throw new Error(`云端视频“${name}”大小与话术记录不一致`)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error(`云端视频“${name}”校验失败`)
  await writeVideoAsset('cloud', id, name, bytes)
  return bytes
}
async function pruneVideoAssets(workspace, library) {
  const referenced = new Set((library?.phrases ?? []).flatMap((phrase) => (phrase.videos ?? []).map((video) => video.id)))
  const folder = path.join(app.getPath('userData'), 'video-assets', workspace === 'cloud' ? 'cloud' : 'local')
  let entries
  try { entries = await fs.readdir(folder, { withFileTypes: true }) }
  catch (error) { if (error?.code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const id = entry.name.replace(/\.[^.]+$/, '')
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(id) && !referenced.has(id)) await fs.rm(path.join(folder, entry.name), { force: true })
  }
}
async function syncVideoAttachments(client, library, allowUpload, state) {
  const videos = new Map()
  for (const phrase of library?.phrases ?? []) {
    for (const video of phrase.videos ?? []) {
      const existing = videos.get(video.id)
      if (existing && (existing.name !== video.name || existing.mime !== video.mime || existing.size !== video.size || existing.sha256 !== video.sha256)) {
        throw new Error(`视频附件“${video.name}”的引用信息不一致`)
      }
      videos.set(video.id, video)
    }
  }
  const knownAssets = { ...(state.videoAssets ?? {}) }
  for (const id of Object.keys(knownAssets)) if (!videos.has(id)) delete knownAssets[id]
  for (const video of videos.values()) {
    const cached = knownAssets[video.id]
    const localStat = await statVideoAsset('cloud', video.id, video.name)
    const localBytes = localStat ? await readVideoAsset('cloud', video.id, video.name) : null
    const localMatches = localBytes && localBytes.length === video.size && createHash('sha256').update(localBytes).digest('hex') === video.sha256
    const cacheAge = Date.now() - Number(cached?.verifiedAt)
    const cacheFresh = cached?.size === video.size && cached.sha256 === video.sha256 && Number.isFinite(cached.verifiedAt) && cacheAge >= 0 && cacheAge < 6 * 60 * 60 * 1000
    const remoteExists = await client.hasVideo(video.id)
    if (localMatches && allowUpload) {
      if (remoteExists && cacheFresh) continue
      if (remoteExists) {
        const remoteBytes = await client.getVideo(video.id)
        const remoteMatches = remoteBytes && remoteBytes.length === video.size && createHash('sha256').update(remoteBytes).digest('hex') === video.sha256
        if (!remoteMatches) await client.putVideo(video.id, localBytes)
      } else {
        await client.putVideo(video.id, localBytes)
      }
    } else {
      if (!remoteExists) throw new Error(`视频附件“${video.name}”在坚果云中不存在，当前设备也无法上传`)
      const remoteBytes = await client.getVideo(video.id)
      if (!remoteBytes || remoteBytes.length !== video.size) throw new Error(`坚果云视频附件“${video.name}”缺失或大小不一致`)
      if (createHash('sha256').update(remoteBytes).digest('hex') !== video.sha256) throw new Error(`坚果云视频附件“${video.name}”校验失败`)
      if (!localMatches) await writeVideoAsset('cloud', video.id, video.name, remoteBytes)
    }
    knownAssets[video.id] = { size: video.size, sha256: video.sha256, verifiedAt: Date.now() }
  }
  state.videoAssets = knownAssets
}
function publishLibraryUpdated(workspace, value) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('library:updated', { workspace, value })
}
async function readSyncState() {
  try {
    const stored = JSON.parse(await fs.readFile(syncStatePath(), 'utf8'))
    const snapshot = stored.entries ?? stored.baseline ?? {}
    return { ...stored, entries: snapshot, baseline: stored.baseline ?? snapshot }
  }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('本机同步状态无法读取，请先备份话术库')
    return { deviceId: randomUUID(), initialized: false, entries: {}, baseline: null }
  }
}
async function writeSyncState(state) {
  const file = syncStatePath()
  const temporary = file + '.' + process.pid + '.tmp'
  const snapshot = state.entries ?? state.baseline ?? {}
  const stored = { deviceId: state.deviceId, initialized: state.initialized, entries: snapshot, remoteScope: state.remoteScope, ownerDeviceId: state.ownerDeviceId, videoAssets: state.videoAssets ?? {} }
  await fs.writeFile(temporary, JSON.stringify(stored), 'utf8')
  await fs.rename(temporary, file)
}
function serializeData(task) {
  const result = dataQueue.then(task, task)
  dataQueue = result.catch(() => {})
  return result
}
function publishSyncStatus(value) {
  syncStatus = { ...syncStatus, ...value }
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('sync:status', syncStatus)
  return syncStatus
}
function accessFromState(settings, state) {
  const saved = settings.cloudSync
  if (!saved?.encryptedPassword) return { configured: false, deviceRole: 'local', canEdit: true }
  let remoteScope = ''
  try { remoteScope = normalizeBaseUrl(saved.url || DEFAULT_URL) + '\n' + String(saved.username ?? '').trim().toLocaleLowerCase() } catch {}
  const ownerDeviceId = state.remoteScope === remoteScope ? state.ownerDeviceId : null
  const requestedRole = saved.deviceRole === 'readonly' ? 'readonly' : 'primary'
  const canEdit = requestedRole === 'primary' && (!ownerDeviceId || ownerDeviceId === state.deviceId)
  return { configured: true, deviceRole: canEdit ? 'primary' : 'readonly', canEdit }
}
async function getDeviceAccess() { return accessFromState(await readSettings(), await readSyncState()) }
async function readSyncCredential() {
  const settings = await readSettings()
  const saved = settings.cloudSync
  if (!saved?.encryptedPassword) return null
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，请重启应用后重试')
  return { url: saved.url || DEFAULT_URL, username: saved.username, password: safeStorage.decryptString(Buffer.from(saved.encryptedPassword, 'base64')) }
}
function publicSyncConfig(saved) {
  return saved ? { configured: true, url: saved.url || DEFAULT_URL, username: saved.username || '', deviceRole: saved.deviceRole === 'readonly' ? 'readonly' : 'primary' } : { configured: false, url: DEFAULT_URL, username: '', deviceRole: 'primary' }
}
async function backupCloudLibrary(raw, reason) {
  if (!raw) return null
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const backupPath = path.join(app.getPath('userData'), `cloud-library-${reason}-${digest}.json`)
  try { await fs.writeFile(backupPath, raw, { encoding: 'utf8', flag: 'wx' }) }
  catch (error) { if (error?.code !== 'EEXIST') throw error }
  return backupPath
}
async function runSyncInternal() {
  const settings = await readSettings()
  const credential = await readSyncCredential()
  if (!credential) return publishSyncStatus({ configured: false, syncing: false, error: '', deviceRole: 'local', canEdit: true })
  const requestedRole = settings.cloudSync?.deviceRole === 'readonly' ? 'readonly' : 'primary'
  publishSyncStatus({ configured: true, syncing: true, error: '', message: '正在连接坚果云', deviceRole: requestedRole, canEdit: false })
  try {
    const state = await readSyncState()
    const remoteScope = normalizeBaseUrl(credential.url) + '\n' + credential.username.trim().toLocaleLowerCase()
    const raw = await readLibrary('cloud')
    let localLibrary = null
    if (raw) {
      try { localLibrary = JSON.parse(raw) }
      catch { throw new Error('本机话术库无法解析，已暂停云同步') }
      if (!Array.isArray(localLibrary.categories) || !Array.isArray(localLibrary.phrases)) throw new Error('本机话术库格式不正确，已暂停云同步')
    }
    const remoteScopeChanged = Boolean(state.remoteScope && state.remoteScope !== remoteScope)
    if (remoteScopeChanged && raw) await backupCloudLibrary(raw, 'previous-account')
    const activeState = remoteScopeChanged
      ? { deviceId: state.deviceId || randomUUID(), initialized: false, entries: {}, baseline: null, remoteScope, ownerDeviceId: null }
      : { ...state, remoteScope }
    const syncLibrary = remoteScopeChanged ? null : localLibrary
    const client = createWebDavClient(credential)
    if (requestedRole === 'readonly') await client.checkFolder()
    else await client.prepareFolder()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const remote = await client.getDocument()
      if (!remote.document && !remoteScopeChanged && activeState.initialized && activeState.remoteScope === remoteScope) {
        if (raw) await backupCloudLibrary(raw, 'remote-missing')
        throw new Error('坚果云云端主库文件不存在，已暂停同步以防本机缓存覆盖云端；本机缓存已保留，请先在坚果云恢复同步文件。')
      }
      const remoteOwner = remote.document?.ownerDeviceId ?? null
      if (remoteOwner && (remoteOwner !== activeState.deviceId || requestedRole === 'readonly')) {
        if (remoteOwner !== activeState.deviceId) {
          activeState.ownerDeviceId = remoteOwner
          await writeSyncState(activeState)
        }
        const access = { deviceRole: 'readonly', canEdit: false }
        publishSyncStatus({ configured: true, syncing: true, error: '', message: '正在下载主设备内容（只读）', ...access })
        const readonlyLibrary = buildLibrary(remote.document.entries)
        await pruneVideoAssets('cloud', readonlyLibrary)
        const readonlyRaw = JSON.stringify(readonlyLibrary)
        const shouldBackup = Boolean(raw && (state.remoteScope !== remoteScope || state.ownerDeviceId !== remoteOwner) && raw !== readonlyRaw)
        if (shouldBackup) {
          const backupPath = path.join(app.getPath('userData'), `cloud-library-before-readonly-${Date.now()}.json`)
          await fs.writeFile(backupPath, raw, 'utf8')
        }
        if (readonlyRaw !== raw) {
          await writeLibrary(readonlyRaw, 'cloud')
          publishLibraryUpdated('cloud', readonlyRaw)
        }
        const snapshot = clone(remote.document.entries)
        if (!state.initialized || state.remoteScope !== remoteScope || state.ownerDeviceId !== remoteOwner || !sameEntries(state.entries, snapshot) || JSON.stringify(state.videoAssets ?? {}) !== JSON.stringify(activeState.videoAssets ?? {})) {
          await writeSyncState({ ...activeState, initialized: true, entries: snapshot, baseline: snapshot, remoteScope, ownerDeviceId: remoteOwner })
        }
        const lastSyncAt = Date.now()
        const latestSettings = await readSettings()
        if (latestSettings.cloudSync) await writeSettings({ ...latestSettings, cloudSync: { ...latestSettings.cloudSync, lastSyncAt } })
        return publishSyncStatus({ configured: true, syncing: false, lastSyncAt, conflictCount: 0, error: '', message: '已获取主设备内容（只读）', ...access })
      }
      if (!remoteOwner && requestedRole === 'readonly') throw new Error('云端尚未指定主设备，请先在主电脑选择“主电脑”并完成首次同步')
      const localState = syncLibrary ? trackLocalLibrary(syncLibrary, activeState, activeState.deviceId) : activeState
      const result = mergeCloudPrimaryEntries(localState.entries ?? {}, remote.document?.entries ?? {}, localState.baseline, Boolean(remote.document))
      restoreMissingCategories(result.entries, localState.deviceId)
      const mergedLibrary = buildLibrary(result.entries, syncLibrary)
      await syncVideoAttachments(client, mergedLibrary, true, localState)
      const mergedRaw = JSON.stringify(mergedLibrary)
      if (result.conflictCount > 0 && raw && mergedRaw !== raw) await backupCloudLibrary(raw, 'cloud-priority-conflict')
      const document = { schemaVersion: 1, updatedAt: Date.now(), deviceId: localState.deviceId, ownerDeviceId: localState.deviceId, entries: result.entries }
      const ownershipChanged = !remote.document?.ownerDeviceId
      if ((ownershipChanged || !sameEntries(result.entries, remote.document?.entries)) && !await client.putDocument(document, remote.etag, Boolean(remote.document), remote.lastModified)) continue
      await pruneVideoAssets('cloud', mergedLibrary)
      if (mergedRaw !== raw) {
        await writeLibrary(mergedRaw, 'cloud')
        publishLibraryUpdated('cloud', mergedRaw)
      }
      const snapshot = clone(result.entries)
      if (!state.initialized || state.remoteScope !== remoteScope || state.ownerDeviceId !== localState.deviceId || !sameEntries(state.entries, snapshot) || JSON.stringify(state.videoAssets ?? {}) !== JSON.stringify(localState.videoAssets ?? {})) {
        await writeSyncState({ ...localState, initialized: true, entries: snapshot, baseline: snapshot, remoteScope, ownerDeviceId: localState.deviceId })
      }
      const lastSyncAt = Date.now()
      const latestSettings = await readSettings()
      if (latestSettings.cloudSync) await writeSettings({ ...latestSettings, cloudSync: { ...latestSettings.cloudSync, lastSyncAt } })
      return publishSyncStatus({ configured: true, syncing: false, lastSyncAt, conflictCount: result.conflictCount, error: '', message: result.conflictCount ? `已以坚果云为准完成同步，发现 ${result.conflictCount} 处冲突并备份本机副本` : '云端优先同步完成', deviceRole: 'primary', canEdit: true })
    }
    throw new Error('云端数据正在被其他设备更新，请稍后重试')
  } catch (error) {
    const access = await getDeviceAccess().catch(() => ({ configured: true, deviceRole: 'readonly', canEdit: false }))
    publishSyncStatus({ configured: true, syncing: false, ...access, error: error?.message || '同步失败', message: '同步失败' })
    throw error
  }
}
function syncNow() { return serializeData(runSyncInternal) }
function scheduleSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    void readSettings().then((settings) => { if (settings.cloudSync?.encryptedPassword) return syncNow().catch(() => {}) })
  }, 1000)
  syncTimer.unref?.()
}
async function configureSync(value) {
  return serializeData(async () => {
    const settings = await readSettings()
    const previous = settings.cloudSync
    const typedPassword = String(value?.password ?? '')
    let password = typedPassword
    if (!password && previous?.encryptedPassword) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，请重启应用后重试')
      password = safeStorage.decryptString(Buffer.from(previous.encryptedPassword, 'base64'))
    }
    if (!password) throw new Error('请填写坚果云第三方应用密码')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，未保存任何密码')
    const url = normalizeBaseUrl(value?.url || DEFAULT_URL)
    const username = String(value?.username ?? '').trim()
    if (!username) throw new Error('请填写坚果云账号邮箱')
    const deviceRole = value?.deviceRole === 'readonly' ? 'readonly' : 'primary'
    const client = createWebDavClient({ url, username, password })
    if (deviceRole === 'readonly') await client.checkFolder()
    else await client.prepareFolder()
    const encryptedPassword = typedPassword ? safeStorage.encryptString(password).toString('base64') : previous.encryptedPassword
    await writeSettings({ ...settings, cloudSync: { ...previous, url, username, encryptedPassword, deviceRole } })
    publishSyncStatus({ configured: true, syncing: false, error: '', deviceRole, canEdit: deviceRole === 'primary' })
    try { return await runSyncInternal() }
    catch { return syncStatus }
  })
}
async function disconnectSync() {
  return serializeData(async () => {
    const settings = await readSettings()
    const { cloudSync, ...remaining } = settings
    await writeSettings(remaining)
    clearTimeout(syncTimer)
    return publishSyncStatus({ configured: false, syncing: false, error: '', message: '已断开云同步', deviceRole: 'local', canEdit: true })
  })
}

async function createClipboardImageFiles(dataUrls) {
  const root = path.join(app.getPath('temp'), 'kefu-desk-clipboard')
  await fs.mkdir(root, { recursive: true })
  const folder = await fs.mkdtemp(path.join(root, 'images-'))
  const fileUrls = []
  for (const [index, dataUrl] of dataUrls.entries()) {
    const image = nativeImage.createFromDataURL(String(dataUrl ?? ''))
    if (image.isEmpty()) continue
    const filePath = path.join(folder, `image-${index + 1}.png`)
    await fs.writeFile(filePath, image.toPNG())
    fileUrls.push(pathToFileURL(filePath).href)
  }
  if (!fileUrls.length) {
    await fs.rm(folder, { recursive: true, force: true })
    return ''
  }
  const cleanup = setTimeout(() => void fs.rm(folder, { recursive: true, force: true }), 24 * 60 * 60 * 1000)
  cleanup.unref()
  return `${fileUrls.join('\r\n')}\r\n`
}

async function createClipboardVideoFiles(videos, workspace) {
  if (!Array.isArray(videos) || videos.length === 0) return ''
  if (workspace !== 'local' && workspace !== 'cloud') throw new Error('工作区信息无效')
  const root = path.join(app.getPath('temp'), 'kefu-desk-clipboard')
  await fs.mkdir(root, { recursive: true })
  const folder = await fs.mkdtemp(path.join(root, 'videos-'))
  const fileUrls = []
  const usedNames = new Set()
  try {
    for (const video of videos) {
      const id = String(video?.id ?? '')
      const name = String(video?.name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').trim().slice(0, 180)
      const size = Number(video?.size)
      const sha256 = String(video?.sha256 ?? '')
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !name || !Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error('视频附件信息无效，无法复制')
      }
      let bytes = await readVideoAsset(workspace, id, name)
      const matches = (value) => value && value.length === size && createHash('sha256').update(value).digest('hex') === sha256
      if (!matches(bytes) && workspace === 'cloud' && (await readSettings()).cloudSync?.encryptedPassword) {
        bytes = await downloadCloudVideoAsset(id, name, size, sha256)
      }
      if (!matches(bytes)) throw new Error(`视频“${name}”暂不可用或校验失败，请先同步云端工作区`)
      const extension = path.extname(name)
      const baseName = extension ? name.slice(0, -extension.length) : name
      let targetName = name
      let suffix = 2
      while (usedNames.has(targetName.toLocaleLowerCase())) {
        targetName = `${baseName} (${suffix})${extension}`
        suffix += 1
      }
      usedNames.add(targetName.toLocaleLowerCase())
      const filePath = path.join(folder, targetName)
      await fs.writeFile(filePath, bytes, { flag: 'wx' })
      fileUrls.push(pathToFileURL(filePath).href)
    }
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true })
    throw error
  }
  const cleanup = setTimeout(() => void fs.rm(folder, { recursive: true, force: true }), 24 * 60 * 60 * 1000)
  cleanup.unref()
  return `${fileUrls.join('\r\n')}\r\n`
}

function loadRenderer(window, overlay = false) {
  if (app.isPackaged) {
    return window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: overlay ? { overlay: '1' } : {},
    })
  }
  return window.loadURL(`http://127.0.0.1:5173/${overlay ? '?overlay=1' : ''}`)
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: '客服宝桌面版',
    backgroundColor: '#f5f7f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  loadRenderer(mainWindow)
  mainWindow.on('closed', () => { mainWindow = null })
}

function showOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show()
    overlayWindow.focus()
    overlayWindow.webContents.send('overlay-focus')
    return
  }
  overlayWindow = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 360,
    minHeight: 430,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#f5f7f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void readSettings().then((settings) => {
    const pinned = settings.overlayPinned !== false
    const scale = Math.max(0.9, Math.min(1.5, Number(settings.overlayScale) || 1))
    overlayWindow?.setSize(Math.round(420 * scale), Math.round(620 * scale))
    overlayWindow?.setAlwaysOnTop(pinned, 'floating')
    overlayWindow?.setVisibleOnAllWorkspaces(pinned)
    loadRenderer(overlayWindow, true)
    overlayWindow?.once('ready-to-show', () => {
      overlayWindow?.show()
      overlayWindow?.focus()
    })
  })
  overlayWindow.on('closed', () => { overlayWindow = null })
}

ipcMain.handle('library:read', async (_event, requestedWorkspace) => {
  const workspace = requestedWorkspace === 'cloud' ? 'cloud' : 'local'
  const local = await readLibrary(workspace)
  if (workspace === 'cloud' && (await readSettings()).cloudSync) {
    if (local) void syncNow().catch(() => {})
    else {
      try { await syncNow() } catch {}
    }
  }
  return local ?? (workspace === 'cloud' ? JSON.stringify({ categories: [], phrases: [] }) : null)
})
ipcMain.handle('library:write', async (event, value, requestedWorkspace) => serializeData(async () => {
  const workspace = requestedWorkspace === 'cloud' ? 'cloud' : 'local'
  if (workspace === 'cloud') {
    const settings = await readSettings()
    if (!settings.cloudSync?.encryptedPassword) throw new Error('请先连接坚果云，再编辑云端工作区')
    const access = await getDeviceAccess()
    if (!access.canEdit) throw new Error('云端工作区为只读模式，只有主电脑可以修改话术库')
  }
  const serialized = String(value ?? '')
  let library
  try { library = JSON.parse(serialized) }
  catch { throw new Error('话术库格式不正确，未保存') }
  if (!Array.isArray(library.categories) || !Array.isArray(library.phrases)) throw new Error('话术库格式不正确，未保存')
  await writeLibrary(serialized, workspace)
  if (workspace === 'local') await pruneVideoAssets(workspace, library)
  publishLibraryUpdated(workspace, serialized)
  if (workspace === 'cloud') scheduleSync()
  return true
}))
ipcMain.handle('video:write', async (_event, value, requestedWorkspace) => {
  const workspace = requestedWorkspace === 'cloud' ? 'cloud' : 'local'
  if (workspace === 'cloud') {
    const settings = await readSettings()
    if (!settings.cloudSync?.encryptedPassword) throw new Error('请先连接坚果云，再添加云端视频附件')
    const access = await getDeviceAccess()
    if (!access.canEdit) throw new Error('云端工作区为只读模式，只有主电脑可以添加视频')
  }
  const payload = value && typeof value === 'object' ? value : {}
  const name = String(payload.name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').trim().slice(0, 180)
  const mime = String(payload.mime ?? '').trim().slice(0, 128)
  if (!name || !mime.toLocaleLowerCase().startsWith('video/')) throw new Error('请选择有效的视频文件')
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(payload.id ?? ''))) throw new Error('视频附件标识无效')
  if (payload.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(payload.sha256))) throw new Error('视频附件校验信息无效')
  let bytes
  if (payload.data instanceof ArrayBuffer && payload.data.byteLength <= MAX_VIDEO_BYTES) bytes = Buffer.from(payload.data)
  else if (ArrayBuffer.isView(payload.data) && payload.data.byteLength <= MAX_VIDEO_BYTES) bytes = Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength)
  else throw new Error('视频文件数据无法读取')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (payload.sha256 !== undefined && payload.sha256 !== sha256) throw new Error(`视频“${name}”校验失败，未导入附件`)
  const stored = await writeVideoAsset(workspace, payload.id, name, bytes)
  if (workspace === 'cloud') {
    const state = await readSyncState()
    const videoAssets = { ...(state.videoAssets ?? {}) }
    delete videoAssets[payload.id]
    await writeSyncState({ ...state, videoAssets })
  }
  return { id: payload.id, name, mime, ...stored }
})
ipcMain.handle('video:read', async (_event, id, name, expectedSize, expectedSha256, requestedWorkspace) => {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_VIDEO_BYTES) throw new Error('视频附件大小信息无效')
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256))) throw new Error('视频附件校验信息无效')
  const workspace = requestedWorkspace === 'cloud' ? 'cloud' : 'local'
  let bytes = await readVideoAsset(workspace, id, name)
  if (!bytes && workspace === 'cloud' && (await readSettings()).cloudSync?.encryptedPassword) {
    bytes = await downloadCloudVideoAsset(id, name, expectedSize, expectedSha256)
  }
  if (!bytes) return null
  if (bytes.length !== expectedSize) throw new Error(`视频“${name}”大小与话术记录不一致`)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error(`视频“${name}”校验失败`)
  return Uint8Array.from(bytes)
})
ipcMain.handle('video:reveal', async (_event, id, name, expectedSize, expectedSha256, requestedWorkspace) => {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_VIDEO_BYTES) throw new Error('视频附件大小信息无效')
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256))) throw new Error('视频附件校验信息无效')
  const workspace = requestedWorkspace === 'cloud' ? 'cloud' : 'local'
  const storedPath = videoStorePath(workspace, id, name)
  if (!await fs.stat(storedPath).then(() => true).catch(() => false) && workspace === 'cloud' && (await readSettings()).cloudSync?.encryptedPassword) {
    await downloadCloudVideoAsset(id, name, expectedSize, expectedSha256)
  }
  const bytes = await readVideoAsset(workspace, id, name)
  if (!bytes || bytes.length !== expectedSize || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('视频文件暂不可用或校验失败，请先同步云端工作区')
  shell.showItemInFolder(storedPath)
  return true
})
ipcMain.handle('workspace:get', async () => (await readSettings()).activeWorkspace === 'cloud' ? 'cloud' : 'local')
ipcMain.handle('workspace:set', async (_event, value) => {
  const activeWorkspace = value === 'cloud' ? 'cloud' : 'local'
  const settings = await readSettings()
  await writeSettings({ ...settings, activeWorkspace })
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspace:updated', activeWorkspace)
  if (activeWorkspace === 'cloud' && settings.cloudSync?.encryptedPassword) void syncNow().catch(() => {})
  return activeWorkspace
})
ipcMain.handle('app:get-auto-launch', () => {
  const supported = process.platform === 'win32' && app.isPackaged
  return {
    supported,
    enabled: supported ? getAutoLaunchEnabled() : false,
  }
})
ipcMain.handle('app:set-auto-launch', async (_event, value) => {
  const supported = process.platform === 'win32' && app.isPackaged
  if (!supported) return { supported: false, enabled: false }
  const enabled = Boolean(value)
  return { supported: true, enabled: setAutoLaunchRegistration(enabled) }
})
ipcMain.handle('sync:get-config', async () => publicSyncConfig((await readSettings()).cloudSync))
ipcMain.handle('sync:get-status', async () => {
  const saved = (await readSettings()).cloudSync
  const access = await getDeviceAccess()
  return { ...syncStatus, ...access, canEdit: syncStatus.syncing ? false : access.canEdit, configured: Boolean(saved?.encryptedPassword), lastSyncAt: syncStatus.lastSyncAt || saved?.lastSyncAt || null }
})
ipcMain.handle('sync:configure', async (_event, value) => configureSync(value))
ipcMain.handle('sync:run', async () => { try { await syncNow() } catch {} return syncStatus })
ipcMain.handle('sync:disconnect', disconnectSync)
ipcMain.handle('clipboard:write-text', async (_event, value) => {
  await clipboard.writeText(String(value ?? ''))
  return true
})
ipcMain.handle('clipboard:write-image', async (_event, dataUrl) => {
  const image = nativeImage.createFromDataURL(String(dataUrl ?? ''))
  if (image.isEmpty()) return false
  await clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([image.toPNG()], { type: 'image/png' }),
    }),
  ])
  return true
})
ipcMain.handle('clipboard:write-rich', async (_event, value) => {
  const payload = value && typeof value === 'object' ? value : {}
  const text = String(payload.text ?? '')
  const html = String(payload.html ?? '')
  const imageUrl = String(payload.image ?? '')
  const imageUrls = Array.isArray(payload.images) ? payload.images.filter((item) => typeof item === 'string' && item.length > 0) : imageUrl ? [imageUrl] : []
  if (payload.videos !== undefined && !Array.isArray(payload.videos)) throw new Error('视频附件列表无效')
  const videos = Array.isArray(payload.videos) ? payload.videos : []
  const image = imageUrls.length ? nativeImage.createFromDataURL(imageUrls[0]) : null
  const clipboardData = {}
  if (text) clipboardData['text/plain'] = new Blob([text], { type: 'text/plain' })
  if (html) clipboardData['text/html'] = new Blob([html], { type: 'text/html' })
  const uriLists = []
  if (imageUrls.length > 1) {
    const uriList = await createClipboardImageFiles(imageUrls)
    if (uriList) uriLists.push(uriList.trimEnd())
  } else if (image && !image.isEmpty()) {
    clipboardData['image/png'] = new Blob([image.toPNG()], { type: 'image/png' })
  }
  if (videos.length) uriLists.push(await createClipboardVideoFiles(videos, payload.workspace))
  if (uriLists.length) clipboardData['text/uri-list'] = uriLists.join('\r\n') + '\r\n'
  if (Object.keys(clipboardData).length === 0) return false
  await clipboard.write([new ClipboardItem(clipboardData)])
  return true
})
ipcMain.handle('overlay:hide', () => {
  overlayWindow?.hide()
  return true
})
ipcMain.handle('overlay:resize', async (_event, value) => {
  const direction = Math.sign(Number(value) || 0)
  if (!direction) return 1
  const settings = await readSettings()
  const currentScale = Math.max(0.9, Math.min(1.5, Number(settings.overlayScale) || 1))
  const scale = Math.max(0.9, Math.min(1.5, Math.round((currentScale + direction * 0.1) * 10) / 10))
  await writeSettings({ ...settings, overlayScale: scale })
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setSize(Math.round(420 * scale), Math.round(620 * scale), true)
  return scale
})
ipcMain.handle('overlay:get-pinned', async () => {
  const settings = await readSettings()
  return settings.overlayPinned !== false
})
ipcMain.handle('overlay:get-sort', async () => {
  const settings = await readSettings()
  return {
    mode: settings.overlaySortMode === 'manual' ? 'manual' : 'recent',
    order: Array.isArray(settings.overlayPhraseOrder) ? settings.overlayPhraseOrder.filter((id) => typeof id === 'string') : [],
  }
})
ipcMain.handle('overlay:set-sort', async (_event, value) => {
  const mode = value?.mode === 'manual' ? 'manual' : 'recent'
  const order = Array.isArray(value?.order) ? value.order.filter((id) => typeof id === 'string' && id.length <= 256).slice(0, 50000) : []
  const settings = await readSettings()
  await writeSettings({ ...settings, overlaySortMode: mode, overlayPhraseOrder: order })
  const result = { mode, order }
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('overlay:sort-updated', result)
  return result
})
ipcMain.handle('overlay:set-pinned', async (_event, value) => {
  const pinned = Boolean(value)
  overlayWindow?.setAlwaysOnTop(pinned, 'floating')
  overlayWindow?.setVisibleOnAllWorkspaces(pinned)
  const settings = await readSettings()
  await writeSettings({ ...settings, overlayPinned: pinned })
  return pinned
})

app.whenReady().then(() => {
  createMainWindow()
  globalShortcut.register('CommandOrControl+Shift+Space', showOverlay)
  const retryTimer = setInterval(() => {
    void readSettings().then((settings) => { if (settings.cloudSync?.encryptedPassword) return syncNow().catch(() => {}) })
  }, 60000)
  retryTimer.unref?.()
  app.on('browser-window-focus', () => {
    void readSettings().then((settings) => { if (settings.cloudSync?.encryptedPassword) scheduleSync() })
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
