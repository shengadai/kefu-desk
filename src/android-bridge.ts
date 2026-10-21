import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Share } from '@capacitor/share'
import type { VideoAttachment } from './types'
import {
  configureMobileSync,
  disconnectMobileSync,
  getMobileSyncConfig,
  getMobileSyncStatus,
  onMobileLibraryUpdated,
  onMobileSyncStatus,
  publishMobileLibraryUpdate,
  runMobileSync,
  scheduleMobileSync,
} from './mobile-cloud-sync'

type Workspace = 'local' | 'cloud'
type NativeResult = { success?: boolean; value?: string | null; workspace?: Workspace; permissionGranted?: boolean; running?: boolean }

type KefuAndroidNative = {
  readLibrary: (options: { workspace: Workspace }) => Promise<{ value: string | null }>
  writeLibrary: (options: { workspace: Workspace; value: string }) => Promise<{ success: boolean }>
  writeCloudLibraryCache: (options: { value: string }) => Promise<{ success: boolean }>
  readAppFile: (options: { name: string }) => Promise<{ value: string | null }>
  writeAppFile: (options: { name: string; value: string }) => Promise<void>
  deleteAppFile: (options: { name: string }) => Promise<void>
  getWorkspace: () => Promise<{ workspace: Workspace }>
  setWorkspace: (options: { workspace: Workspace }) => Promise<{ workspace: Workspace }>
  getPetStatus: () => Promise<{ permissionGranted: boolean; running: boolean }>
  requestOverlayPermission: () => Promise<{ permissionGranted: boolean }>
  startPet: () => Promise<void>
  stopPet: () => Promise<void>
  closePetPanel: () => Promise<void>
  copyContent: (options: { text: string; images: string[] }) => Promise<{ success: boolean }>
  setSecret: (options: { value: string }) => Promise<void>
  getSecret: () => Promise<{ value: string | null }>
  removeSecret: () => Promise<void>
  addListener: (eventName: string, listener: (value: NativeResult) => void) => Promise<PluginListenerHandle>
}

const native = registerPlugin<KefuAndroidNative>('KefuAndroid')

function subscribeNative(eventName: string, callback: (value: NativeResult) => void) {
  let handle: PluginListenerHandle | null = null
  void native.addListener(eventName, callback).then((result) => { handle = result })
  return () => { if (handle) void handle.remove() }
}

const androidWorkspace = {
  readLibrary: async (workspace: Workspace) => (await native.readLibrary({ workspace })).value ?? null,
  writeLibrary: async (value: string, workspace: Workspace) => {
    const result = await native.writeLibrary({ value, workspace })
    if (workspace === 'cloud') scheduleMobileSync()
    return Boolean(result.success)
  },
  getWorkspace: async () => (await native.getWorkspace()).workspace,
  setWorkspace: async (workspace: Workspace) => {
    const result = await native.setWorkspace({ workspace })
    if (workspace === 'cloud') void runMobileSync()
    return result.workspace
  },
  getAutoLaunch: async () => ({ supported: false, enabled: false }),
  setAutoLaunch: async () => ({ supported: false, enabled: false }),
  writeVideo: async (_value: { id: string; name: string; mime: string; data: ArrayBuffer; sha256?: string }, _workspace: Workspace) => {
    throw new Error('安卓端暂不支持添加视频附件')
  },
  readVideo: async (_id: string, _name: string, _expectedSize: number, _sha256: string, _workspace: Workspace) => null as Uint8Array | null,
  revealVideo: async (_id: string, _name: string, _expectedSize: number, _sha256: string, _workspace: Workspace) => false,
  copyText: async (value: string) => (await native.copyContent({ text: value, images: [] })).success,
  copyImage: async (value: string) => (await native.copyContent({ text: '', images: [value] })).success,
  copyRich: async (value: { text: string; html: string; image?: string; images?: string[]; videos?: VideoAttachment[]; workspace: Workspace }) => {
    if (value.videos?.length && !value.text && !value.image && !value.images?.length) return false
    return (await native.copyContent({ text: value.text, images: value.images?.length ? value.images : value.image ? [value.image] : [] })).success
  },
  hideOverlay: async () => { await native.closePetPanel(); return true },
  resizeOverlay: async () => 1,
  getOverlayPinned: async () => true,
  setOverlayPinned: async (value: boolean) => value,
  getOverlaySort: async () => {
    const { value } = await Preferences.get({ key: 'android-overlay-sort' })
    if (!value) return { mode: 'recent' as const, order: [] as string[] }
    try { return JSON.parse(value) as { mode: 'recent' | 'manual'; order: string[] } } catch { return { mode: 'recent' as const, order: [] as string[] } }
  },
  setOverlaySort: async (value: { mode: 'recent' | 'manual'; order: string[] }) => {
    await Preferences.set({ key: 'android-overlay-sort', value: JSON.stringify(value) })
    return value
  },
  onOverlaySortUpdated: (_callback: (value: { mode: 'recent' | 'manual'; order: string[] }) => void) => () => undefined,
  getSyncConfig: getMobileSyncConfig,
  getSyncStatus: getMobileSyncStatus,
  configureSync: configureMobileSync,
  runSync: runMobileSync,
  disconnectSync: disconnectMobileSync,
  onOverlayFocus: (_callback: () => void) => () => undefined,
  onLibraryUpdated: (callback: (value: { workspace: Workspace; value: string }) => void) => onMobileLibraryUpdated(callback),
  onWorkspaceUpdated: (callback: (workspace: Workspace) => void) => {
    const unsubscribe = subscribeNative('workspaceChanged', (value) => { if (value.workspace) callback(value.workspace) })
    return unsubscribe
  },
  onSyncStatus: onMobileSyncStatus,
}

export async function saveAndroidExport(content: BlobPart, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('备份文件读取失败'))
    reader.readAsDataURL(blob)
  })
  const path = `exports/${Date.now()}-${filename}`
  const result = await Filesystem.writeFile({ path, data: dataUrl.slice(dataUrl.indexOf(',') + 1), directory: Directory.Cache, recursive: true })
  await Share.share({ title: filename, dialogTitle: '保存或分享客服宝备份', url: result.uri })
}

export function installAndroidBridge() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return
  window.kefuAndroid = native
  window.kefuDesk = androidWorkspace
  void subscribeNative('libraryChanged', (value) => {
    if (value.workspace === 'cloud' && typeof value.value === 'string') publishMobileLibraryUpdate(value.value)
  })
}
