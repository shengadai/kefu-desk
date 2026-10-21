import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent } from 'react'
import { Archive, ArrowDownWideNarrow, ArrowUpRight, Check, ChevronDown, Cloud, Command, Copy, Download, FileSpreadsheet, Film, FolderOpen, GripVertical, HardDrive, ImagePlus, Keyboard, LayoutGrid, MessageCircle, Minus, Moon, MoreHorizontal, Pencil, Pin, PinOff, Play, Plus, Search, Settings, ShieldCheck, Sparkles, Star, Sun, Trash2, Upload, Users, X } from 'lucide-react'
import { pinyin } from 'pinyin-pro'
import type { Row } from 'exceljs'
import { normalizeLibrary, starterLibrary } from './data'
import { buildJsonImportPreview, mergeJsonImport } from './json-import'
import JsonImportDialog from './JsonImportDialog'
import { saveAndroidExport } from './android-bridge'
import type { Category, LibraryData, Phrase, Scope, ScopeFilter, ShortcutModifier, VideoAttachment } from './types'

const scopeNames: Record<Scope, string> = { company: '公司共享', group: '小组共享', private: '私人' }
const colors = ['#6d9cf5', '#4bb99a', '#ed9b56', '#dd7d88', '#9580db', '#44a6b8', '#758b9d']
const overlayMode = new URLSearchParams(window.location.search).has('overlay')
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
type SyncDeviceRole = 'primary' | 'readonly'
type SyncStatus = { configured: boolean; syncing: boolean; lastSyncAt: number | null; conflictCount?: number; error: string; message?: string; deviceRole: 'local' | SyncDeviceRole; canEdit: boolean }
type Workspace = 'local' | 'cloud'
type OverlaySortMode = 'recent' | 'manual'

function phraseImages(phrase: Phrase) {
  if (phrase.images?.length) return phrase.images
  return phrase.image ? [phrase.image] : []
}

function phraseVideos(phrase: Phrase) {
  return phrase.videos ?? []
}

function formatFileSize(size: number) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
}

function isVideoAttachment(value: unknown): value is VideoAttachment {
  if (!value || typeof value !== 'object') return false
  const video = value as Partial<VideoAttachment>
  return typeof video.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(video.id) && typeof video.name === 'string' && video.name.length > 0 && typeof video.mime === 'string' && video.mime.toLocaleLowerCase().startsWith('video/') && typeof video.size === 'number' && Number.isFinite(video.size) && video.size > 0 && video.size <= MAX_VIDEO_BYTES && typeof video.sha256 === 'string' && /^[a-f0-9]{64}$/.test(video.sha256)
}

function sameVideoAttachment(left: VideoAttachment, right: VideoAttachment) {
  return left.name === right.name && left.mime === right.mime && left.size === right.size && left.sha256 === right.sha256
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await window.crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

function buildClipboardHtml(text: string, images: string[]) {
  const textPart = text ? `<div style="white-space:pre-wrap">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>` : ''
  const imagePart = images.map((image) => `<img src="${escapeHtml(image)}" alt="" style="display:block;max-width:100%;margin-top:8px;" />`).join('')
  return textPart || imagePart ? `<div>${textPart}${imagePart}</div>` : ''
}

async function copyClipboardContent(text: string, images: string[], videos: VideoAttachment[], workspace: Workspace) {
  const normalizedImages = images.filter(Boolean)
  const html = buildClipboardHtml(text, normalizedImages)
  if (window.kefuDesk) {
    if (!videos.length && text && normalizedImages.length === 0) return window.kefuDesk.copyText(text)
    if (!videos.length && !text && normalizedImages.length === 1) return window.kefuDesk.copyImage(normalizedImages[0])
    try {
      const copied = await window.kefuDesk.copyRich({ text, html, image: normalizedImages.length === 1 ? normalizedImages[0] : undefined, images: normalizedImages, videos, workspace })
      if (copied) return true
    } catch (error) { if (videos.length) throw error }
    if (videos.length) return false
    if (text) return window.kefuDesk.copyText(text)
    if (normalizedImages[0]) return window.kefuDesk.copyImage(normalizedImages[0])
    return false
  }
  if (videos.length) return false
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const clipboardData: Record<string, Blob> = {
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    }
    if (normalizedImages[0]) {
      try {
        const imageBlob = await (await fetch(normalizedImages[0])).blob()
        if (imageBlob.type) clipboardData[imageBlob.type] = imageBlob
      } catch {}
    }
    await navigator.clipboard.write([new ClipboardItem(clipboardData)])
    return true
  }
  if (text) {
    await navigator.clipboard.writeText(text)
    return true
  }
  if (normalizedImages[0]) {
    const blob = await (await fetch(normalizedImages[0])).blob()
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob } as Record<string, Blob>)])
    return true
  }
  return false
}

function matchesQuery(phrase: Phrase, query: string, category: string) {
  const needle = query.trim().toLocaleLowerCase().replace(/\s/g, '')
  if (!needle) return true
  const text = `${phrase.title} ${phrase.text} ${phrase.tags.join(' ')} ${category}`.toLocaleLowerCase()
  if (text.includes(query.trim().toLocaleLowerCase())) return true
  const syllables = pinyin(text, { toneType: 'none', type: 'array' }).join('').toLowerCase()
  const initials = pinyin(text, { toneType: 'none', type: 'array', pattern: 'first' }).join('').toLowerCase()
  return syllables.includes(needle) || initials.includes(needle)
}

function useLibrary(workspace: Workspace, workspaceReady: boolean) {
  const [library, setLibrary] = useState<LibraryData>(starterLibrary)
  const [readyWorkspace, setReadyWorkspace] = useState<Workspace | null>(null)
  const ignoreNextSave = useRef(false)
  const persistedValue = useRef<string | null>(null)
  const ready = workspaceReady && readyWorkspace === workspace
  useEffect(() => {
    if (!workspaceReady) return
    let active = true
    const load = async () => {
      try {
        setReadyWorkspace(null)
        const raw = window.kefuDesk ? await window.kefuDesk.readLibrary(workspace) : localStorage.getItem(`kefu-desk-library-${workspace}`)
        const parsed = raw ? normalizeLibrary(JSON.parse(raw)) : null
        if (parsed && active) { persistedValue.current = JSON.stringify(parsed); setLibrary(parsed) }
        else if (active) {
          const fallbackLibrary = workspace === 'cloud' ? { categories: [], phrases: [] } : starterLibrary
          persistedValue.current = JSON.stringify(fallbackLibrary)
          setLibrary(fallbackLibrary)
        }
      } catch {
        if (active) {
          const fallbackLibrary = workspace === 'cloud' ? { categories: [], phrases: [] } : starterLibrary
          persistedValue.current = JSON.stringify(fallbackLibrary)
          setLibrary(fallbackLibrary)
        }
      } finally {
        if (active) setReadyWorkspace(workspace)
      }
    }
    void load()
    return () => { active = false }
  }, [workspace, workspaceReady])
  useEffect(() => {
    if (!ready) return
    if (ignoreNextSave.current) { ignoreNextSave.current = false; persistedValue.current = JSON.stringify(library); return }
    const value = JSON.stringify(library)
    if (persistedValue.current === value) return
    const timer = window.setTimeout(() => {
      if (window.kefuDesk) void window.kefuDesk.writeLibrary(value, workspace).then(() => { persistedValue.current = value }).catch(() => {})
      else { localStorage.setItem(`kefu-desk-library-${workspace}`, value); persistedValue.current = value }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [library, ready, workspace])
  useEffect(() => {
    if (!window.kefuDesk) return
    return window.kefuDesk.onLibraryUpdated((update) => {
      if (update.workspace !== workspace) return
      try {
        const parsed = normalizeLibrary(JSON.parse(update.value))
        if (parsed) { ignoreNextSave.current = true; persistedValue.current = JSON.stringify(parsed); setLibrary(parsed) }
      } catch {}
    })
  }, [workspace])
  return [library, setLibrary, ready] as const
}

function OverlayCategories({ categories, categoryId, onSelect }: { categories: Category[]; categoryId: string; onSelect: (category: Category | null) => void }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; clientX: number; scrollLeft: number } | null>(null)
  const [scrollMetrics, setScrollMetrics] = useState({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0, trackWidth: 0 })

  useEffect(() => {
    const scroller = scrollerRef.current
    const track = trackRef.current
    if (!scroller || !track) return
    const updateMetrics = () => setScrollMetrics({
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      trackWidth: track.clientWidth,
    })
    const handleWheel = (event: WheelEvent) => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth
      if (maxScroll <= 0) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      const nextScroll = Math.min(maxScroll, Math.max(0, scroller.scrollLeft + delta))
      if (nextScroll !== scroller.scrollLeft) {
        event.preventDefault()
        scroller.scrollLeft = nextScroll
      }
    }
    scroller.addEventListener('scroll', updateMetrics, { passive: true })
    scroller.addEventListener('wheel', handleWheel, { passive: false })
    const observer = new ResizeObserver(updateMetrics)
    observer.observe(scroller)
    observer.observe(track)
    for (const item of Array.from(scroller.children)) observer.observe(item)
    updateMetrics()
    return () => {
      scroller.removeEventListener('scroll', updateMetrics)
      scroller.removeEventListener('wheel', handleWheel)
      observer.disconnect()
    }
  }, [categories])

  const maxScroll = Math.max(0, scrollMetrics.scrollWidth - scrollMetrics.clientWidth)
  const canScroll = maxScroll > 1 && scrollMetrics.trackWidth > 0
  const thumbWidth = canScroll
    ? Math.min(scrollMetrics.trackWidth, Math.max(24, scrollMetrics.clientWidth / scrollMetrics.scrollWidth * scrollMetrics.trackWidth))
    : scrollMetrics.trackWidth
  const thumbTravel = Math.max(0, scrollMetrics.trackWidth - thumbWidth)
  const thumbLeft = maxScroll > 0 ? scrollMetrics.scrollLeft / maxScroll * thumbTravel : 0

  function moveToTrackPosition(clientX: number) {
    const scroller = scrollerRef.current
    const track = trackRef.current
    if (!scroller || !track || maxScroll <= 0) return
    const trackLeft = track.getBoundingClientRect().left
    const left = Math.min(thumbTravel, Math.max(0, clientX - trackLeft - thumbWidth / 2))
    scroller.scrollLeft = thumbTravel ? left / thumbTravel * maxScroll : 0
  }

  return <div className="overlay-category-scroll-area">
    <div ref={scrollerRef} className="overlay-categories" aria-label="话术分类">
      <button type="button" className={categoryId === 'all' ? 'active' : ''} aria-pressed={categoryId === 'all'} onClick={() => onSelect(null)}>全部</button>
      {categories.map((item) => <button type="button" key={item.id} className={categoryId === item.id ? 'active' : ''} aria-pressed={categoryId === item.id} onClick={() => onSelect(item)}>{item.name}</button>)}
    </div>
    <div
      ref={trackRef}
      className={`overlay-category-scrollbar${canScroll ? '' : ' is-hidden'}`}
      role={canScroll ? 'scrollbar' : undefined}
      aria-label={canScroll ? '话术分类横向滚动条' : undefined}
      aria-orientation={canScroll ? 'horizontal' : undefined}
      aria-valuemin={canScroll ? 0 : undefined}
      aria-valuemax={canScroll ? Math.round(maxScroll) : undefined}
      aria-valuenow={canScroll ? Math.round(scrollMetrics.scrollLeft) : undefined}
      aria-valuetext={canScroll ? `已横向滚动 ${Math.round(scrollMetrics.scrollLeft / maxScroll * 100)}%` : undefined}
      aria-hidden={!canScroll}
      tabIndex={canScroll ? 0 : -1}
      onPointerDown={(event) => {
        if (!canScroll || event.target === thumbRef.current) return
        moveToTrackPosition(event.clientX)
        event.currentTarget.focus()
      }}
      onKeyDown={(event) => {
        const scroller = scrollerRef.current
        if (!canScroll || !scroller) return
        const step = Math.max(48, scroller.clientWidth * 0.2)
        if (event.key === 'ArrowRight' || event.key === 'PageDown') scroller.scrollLeft += step
        else if (event.key === 'ArrowLeft' || event.key === 'PageUp') scroller.scrollLeft -= step
        else if (event.key === 'Home') scroller.scrollLeft = 0
        else if (event.key === 'End') scroller.scrollLeft = maxScroll
        else return
        event.preventDefault()
      }}
    >
      <div
        ref={thumbRef}
        className="overlay-category-scroll-thumb"
        style={{ width: `${thumbWidth}px`, transform: `translateX(${thumbLeft}px)` }}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, scrollLeft: scrollerRef.current?.scrollLeft ?? 0 }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          const scroller = scrollerRef.current
          if (!drag || drag.pointerId !== event.pointerId || !scroller || thumbTravel <= 0) return
          scroller.scrollLeft = drag.scrollLeft + (event.clientX - drag.clientX) / thumbTravel * maxScroll
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
        onLostPointerCapture={() => { dragRef.current = null }}
      />
    </div>
  </div>
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>('local')
  const [workspaceReady, setWorkspaceReady] = useState(!window.kefuDesk)
  const [library, setLibrary, ready] = useLibrary(workspace, workspaceReady)
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [categoryId, setCategoryId] = useState('all')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [sortRecent, setSortRecent] = useState(true)
  const [manualMainSort, setManualMainSort] = useState(false)
  const [overlaySortMode, setOverlaySortMode] = useState<OverlaySortMode>('recent')
  const [overlayPhraseOrder, setOverlayPhraseOrder] = useState<string[]>([])
  const [overlaySortReady, setOverlaySortReady] = useState(!window.kefuDesk)
  const [draggedPhraseId, setDraggedPhraseId] = useState<string | null>(null)
  const [dragTargetPhraseId, setDragTargetPhraseId] = useState<string | null>(null)
  const [draggedCategoryId, setDraggedCategoryId] = useState<string | null>(null)
  const [dragTargetCategoryId, setDragTargetCategoryId] = useState<string | null>(null)
  const [editor, setEditor] = useState<Phrase | null | 'new'>(null)
  const [categoryEditor, setCategoryEditor] = useState<Category | null | 'new'>(null)
  const [toast, setToast] = useState('')
  const [dark, setDark] = useState(() => localStorage.getItem('kefu-desk-dark') === 'true')
  const [selected, setSelected] = useState<string[]>([])
  const [overlayPinned, setOverlayPinned] = useState(true)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [pendingJsonImport, setPendingJsonImport] = useState<{ filename: string; data: LibraryData; workspace: Workspace; videoReferences: number } | null>(null)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [autoLaunchSupported, setAutoLaunchSupported] = useState(Boolean(window.kefuDesk && !window.kefuAndroid))
  const [autoLaunchEnabled, setAutoLaunchEnabled] = useState(false)
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false)
  const [autoLaunchError, setAutoLaunchError] = useState('')
  const [petPermissionGranted, setPetPermissionGranted] = useState(false)
  const [petRunning, setPetRunning] = useState(false)
  const [petBusy, setPetBusy] = useState(false)
  const [videoPreview, setVideoPreview] = useState<{ video: VideoAttachment; url: string } | null>(null)
  const [videoPreviewBusy, setVideoPreviewBusy] = useState(false)
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false)
  const [syncConfig, setSyncConfig] = useState({ configured: false, url: 'https://dav.jianguoyun.com/dav/', username: '', deviceRole: 'primary' as SyncDeviceRole })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ configured: false, syncing: false, lastSyncAt: null, error: '', deviceRole: 'local', canEdit: true })
  const [syncAccessReady, setSyncAccessReady] = useState(!window.kefuDesk)
  const [syncUrl, setSyncUrl] = useState('https://dav.jianguoyun.com/dav/')
  const [syncUsername, setSyncUsername] = useState('')
  const [syncPassword, setSyncPassword] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncError, setSyncError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const jsonImportPreview = useMemo(() => pendingJsonImport && pendingJsonImport.workspace === workspace ? buildJsonImportPreview(library, pendingJsonImport.data) : null, [library, pendingJsonImport, workspace])
  useEffect(() => { setPendingJsonImport(null) }, [workspace])
  const showToast = (message: string) => {
    setToast(message)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setToast(''), 2100)
  }
  async function openVideoPreview(video: VideoAttachment) {
    if (window.kefuAndroid) return showToast('安卓端暂不支持播放视频附件')
    if (!window.kefuDesk) return showToast('视频播放仅支持桌面版')
    setVideoPreviewBusy(true)
    try {
      const bytes = await window.kefuDesk.readVideo(video.id, video.name, video.size, video.sha256, workspace)
      if (!bytes) return showToast(`视频“${video.name}”暂不可用，请先同步云端工作区`)
      const url = URL.createObjectURL(new Blob([bytes], { type: video.mime }))
      setVideoPreview((current) => {
        if (current) URL.revokeObjectURL(current.url)
        return { video, url }
      })
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取视频失败')
    } finally { setVideoPreviewBusy(false) }
  }
  function closeVideoPreview() {
    setVideoPreview((current) => {
      if (current) URL.revokeObjectURL(current.url)
      return null
    })
  }
  async function revealVideo(video: VideoAttachment) {
    if (!window.kefuDesk) return
    try {
      await window.kefuDesk.revealVideo(video.id, video.name, video.size, video.sha256, workspace)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开视频文件位置失败')
    }
  }
  async function switchWorkspace(nextWorkspace: Workspace) {
    setWorkspaceMenuOpen(false)
    if (nextWorkspace === workspace) return
    if (nextWorkspace === 'cloud' && !window.kefuDesk) return showToast('云端工作区仅支持桌面版坚果云同步')
    try {
      if (window.kefuDesk) await window.kefuDesk.setWorkspace(nextWorkspace)
      setWorkspace(nextWorkspace)
    } catch {
      showToast('工作区切换失败，请重试')
    }
  }
  useEffect(() => {
    const api = window.kefuDesk
    if (!api) return
    let active = true
    void api.getWorkspace().then((activeWorkspace) => {
      if (!active) return
      setWorkspace(activeWorkspace)
      setWorkspaceReady(true)
    }).catch(() => { if (active) setWorkspaceReady(true) })
    void api.getSyncConfig().then((config) => {
      if (!active) return
      setSyncConfig(config); setSyncUrl(config.url); setSyncUsername(config.username)
      return api.getSyncStatus().then((status) => {
        if (active) setSyncStatus(status)
      })
    }).catch(() => {}).finally(() => { if (active) setSyncAccessReady(true) })
    void api.getAutoLaunch().then((autoLaunch) => {
      if (active) { setAutoLaunchSupported(autoLaunch.supported); setAutoLaunchEnabled(autoLaunch.enabled) }
    }).catch(() => {})
    const unsubscribe = api.onSyncStatus(setSyncStatus)
    const unsubscribeWorkspace = api.onWorkspaceUpdated((activeWorkspace) => setWorkspace(activeWorkspace))
    return () => { active = false; unsubscribe(); unsubscribeWorkspace() }
  }, [])
  useEffect(() => {
    const android = window.kefuAndroid
    if (!android) return
    let active = true
    void android.getPetStatus().then((status) => {
      if (active) { setPetPermissionGranted(status.permissionGranted); setPetRunning(status.running) }
    }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!exportMenuOpen) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExportMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [exportMenuOpen])
  useEffect(() => {
    setScope('all')
    setCategoryId('all')
    setFavoritesOnly(false)
    setSelected([])
    setQuery('')
    setEditor(null)
    setCategoryEditor(null)
  }, [workspace])
  useEffect(() => {
    if (workspace !== 'cloud' || !syncAccessReady || !syncConfig.configured || syncStatus.canEdit) return
    setEditor(null)
    setCategoryEditor(null)
  }, [workspace, syncAccessReady, syncConfig.configured, syncStatus.canEdit])
  async function openSyncSettings() {
    setSyncError(''); setSyncPassword('')
    if (window.kefuDesk) {
      try {
        const [config, status] = await Promise.all([window.kefuDesk.getSyncConfig(), window.kefuDesk.getSyncStatus()])
        setSyncConfig(config); setSyncUrl(config.url); setSyncUsername(config.username); setSyncStatus(status)
      } catch {}
    }
    setSyncSettingsOpen(true)
  }
  async function toggleAutoLaunch() {
    if (!window.kefuDesk || autoLaunchBusy) return
    setAutoLaunchBusy(true); setAutoLaunchError('')
    try {
      const requested = !autoLaunchEnabled
      const result = await window.kefuDesk.setAutoLaunch(requested)
      setAutoLaunchSupported(result.supported); setAutoLaunchEnabled(result.enabled)
      if (!result.supported) setAutoLaunchError('开机自启动仅支持 Windows 桌面安装版')
      else if (result.enabled !== requested) setAutoLaunchError('Windows 未能应用此启动设置，请检查系统启动应用权限')
      else showToast(result.enabled ? '已开启开机自启动' : '已关闭开机自启动')
    } catch (error) {
      setAutoLaunchError(error instanceof Error ? error.message : '开机自启动设置失败，请重试')
    } finally { setAutoLaunchBusy(false) }
  }
  async function togglePet() {
    const android = window.kefuAndroid
    if (!android || petBusy) return
    setPetBusy(true); setAutoLaunchError('')
    try {
      if (petRunning) {
        await android.stopPet()
        setPetRunning(false)
        showToast('宠物悬浮窗已关闭')
        return
      }
      let permitted = petPermissionGranted
      if (!permitted) {
        const result = await android.requestOverlayPermission()
        permitted = result.permissionGranted
        setPetPermissionGranted(permitted)
      }
      if (!permitted) {
        setAutoLaunchError('需要允许客服宝“显示在其他应用上层”后才能开启宠物。')
        return
      }
      await android.startPet()
      setPetRunning(true)
      showToast('蓝发鲸鱼宠物已显示在桌面')
    } catch (error) {
      setAutoLaunchError(error instanceof Error ? error.message : '宠物悬浮窗设置失败，请重试')
    } finally { setPetBusy(false) }
  }
  async function saveSyncSettings(event: FormEvent) {
    event.preventDefault()
    if (!window.kefuDesk) return setSyncError('当前版本不支持坚果云同步')
    setSyncBusy(true); setSyncError('')
    try {
      const status = await window.kefuDesk.configureSync({ url: syncUrl, username: syncUsername, password: syncPassword, deviceRole: window.kefuAndroid ? 'readonly' : syncConfig.deviceRole })
      setSyncPassword('')
      setSyncStatus(status)
      const config = await window.kefuDesk.getSyncConfig()
      setSyncConfig(config)
      if (status.error) setSyncError(status.error)
      else {
        setSyncSettingsOpen(false); showToast(status.canEdit ? '坚果云已连接，本机为主电脑' : '坚果云已连接，本机为只读设备')
      }
    } catch (error) { setSyncError(error instanceof Error ? error.message : '连接失败') }
    finally { setSyncBusy(false) }
  }
  async function syncNowManually() {
    if (!window.kefuDesk) return
    setSyncBusy(true); setSyncError('')
    try {
      const status = await window.kefuDesk.runSync()
      setSyncStatus(status)
      if (status.error) setSyncError(status.error)
      else showToast(status.message || '同步完成')
    } finally { setSyncBusy(false) }
  }
  async function disconnectCloudSync() {
    if (!window.kefuDesk || !window.confirm('断开后将停止同步，本地话术和坚果云中的文件都会保留。确定断开吗？')) return
    const status = await window.kefuDesk.disconnectSync()
    setSyncStatus(status); setSyncConfig({ configured: false, url: syncUrl, username: '', deviceRole: 'primary' }); setSyncUsername(''); setSyncPassword('')
    setSyncSettingsOpen(false); showToast('已断开坚果云同步')
  }
  const visible = useMemo(() => {
    const orderIndex = manualMainSort ? new Map(overlayPhraseOrder.map((id, index) => [id, index])) : null
    const libraryIndex = manualMainSort ? new Map(library.phrases.map((phrase, index) => [phrase.id, index])) : null
    return library.phrases.filter((phrase) => {
      const category = library.categories.find((item) => item.id === phrase.categoryId)
      if (scope !== 'all' && category?.scope !== scope) return false
      if (categoryId !== 'all' && phrase.categoryId !== categoryId) return false
      if (favoritesOnly && !phrase.favorite) return false
      return matchesQuery(phrase, query, category?.name ?? '')
    }).sort((first, second) => {
      if (orderIndex) {
        const firstIndex = orderIndex.get(first.id)
        const secondIndex = orderIndex.get(second.id)
        if (firstIndex !== undefined && secondIndex !== undefined) return firstIndex - secondIndex
        if (firstIndex !== undefined) return -1
        if (secondIndex !== undefined) return 1
        return (libraryIndex?.get(first.id) ?? 0) - (libraryIndex?.get(second.id) ?? 0)
      }
      return sortRecent ? second.updatedAt - first.updatedAt : first.title.localeCompare(second.title, 'zh-CN')
    })
  }, [library, scope, categoryId, favoritesOnly, query, sortRecent, manualMainSort, overlayPhraseOrder])
  const overlayVisible = useMemo(() => {
    if (overlaySortMode !== 'manual') return visible
    const orderIndex = new Map(overlayPhraseOrder.map((id, index) => [id, index]))
    const libraryIndex = new Map(library.phrases.map((phrase, index) => [phrase.id, index]))
    return [...visible].sort((first, second) => {
      const firstIndex = orderIndex.get(first.id)
      const secondIndex = orderIndex.get(second.id)
      if (firstIndex === undefined && secondIndex === undefined) return (libraryIndex.get(first.id) ?? 0) - (libraryIndex.get(second.id) ?? 0)
      if (firstIndex === undefined) return 1
      if (secondIndex === undefined) return -1
      return firstIndex - secondIndex
    })
  }, [visible, overlaySortMode, overlayPhraseOrder])
  const selectedVisible = visible.filter((phrase) => selected.includes(phrase.id))
  const grouped = useMemo(() => {
    const categories = scope === 'all' ? library.categories : library.categories.filter((item) => item.scope === scope)
    return { company: categories.filter((item) => item.scope === 'company'), group: categories.filter((item) => item.scope === 'group'), private: categories.filter((item) => item.scope === 'private') }
  }, [library.categories, scope])
  useEffect(() => { localStorage.setItem('kefu-desk-dark', String(dark)) }, [dark])
  useEffect(() => {
    let active = true
    const api = window.kefuDesk
    const applySort = (value: { mode: OverlaySortMode; order: string[] }) => {
      if (!active) return
      setOverlaySortMode(value.mode)
      setOverlayPhraseOrder(value.order)
      setManualMainSort(value.mode === 'manual')
      if (value.mode === 'recent') setSortRecent(true)
    }
    if (overlayMode) {
      searchRef.current?.focus()
      void api?.getOverlayPinned().then(setOverlayPinned)
    }
    const unsubscribeSort = api?.onOverlaySortUpdated(applySort)
    const unsubscribeFocus = overlayMode ? api?.onOverlayFocus(() => searchRef.current?.focus()) : undefined
    if (api) {
      void api.getOverlaySort().then(applySort).catch(() => {}).finally(() => { if (active) setOverlaySortReady(true) })
    } else {
      try {
        const stored = JSON.parse(localStorage.getItem('kefu-desk-overlay-sort') ?? 'null')
        if ((stored?.mode === 'manual' || stored?.mode === 'recent') && Array.isArray(stored?.order)) applySort({ mode: stored.mode, order: stored.order })
      } catch {}
      setOverlaySortReady(true)
    }
    return () => {
      active = false
      unsubscribeSort?.()
      unsubscribeFocus?.()
    }
  }, [])

  async function saveOverlaySort(mode: OverlaySortMode, order: string[]) {
    setOverlaySortMode(mode)
    setOverlayPhraseOrder(order)
    setManualMainSort(mode === 'manual')
    if (mode === 'recent') setSortRecent(true)
    if (!window.kefuDesk) {
      localStorage.setItem('kefu-desk-overlay-sort', JSON.stringify({ mode, order }))
      return
    }
    try {
      await window.kefuDesk.setOverlaySort({ mode, order })
    } catch {
      showToast('浮窗排序设置保存失败')
    }
  }

  function selectOverlaySortMode(mode: OverlaySortMode) {
    const phraseIds = new Set(library.phrases.map((phrase) => phrase.id))
    const order = overlayPhraseOrder.filter((id, index, values) => phraseIds.has(id) && values.indexOf(id) === index)
    if (mode === 'manual') {
      const includedIds = new Set(order)
      const missingPhrases = library.phrases
        .filter((phrase) => !includedIds.has(phrase.id))
        .sort((first, second) => second.updatedAt - first.updatedAt)
      order.push(...missingPhrases.map((phrase) => phrase.id))
    }
    void saveOverlaySort(mode, order)
  }

  function handlePhraseDragStart(phraseId: string, event: ReactDragEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button, input, textarea, select, a')) {
      event.preventDefault()
      return
    }
    setDraggedPhraseId(phraseId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', phraseId)
  }

  function handlePhraseDragOver(phraseId: string, event: ReactDragEvent<HTMLElement>) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (phraseId !== draggedPhraseId) setDragTargetPhraseId(phraseId)
  }

  function handlePhraseDrop(phraseId: string, event: ReactDragEvent<HTMLElement>, orderedVisible: Phrase[]) {
    event.preventDefault()
    const draggedId = event.dataTransfer.getData('text/plain') || draggedPhraseId
    if (!draggedId || draggedId === phraseId) {
      setDraggedPhraseId(null)
      setDragTargetPhraseId(null)
      return
    }
    const visibleIds = orderedVisible.map((phrase) => phrase.id)
    const sourceIndex = visibleIds.indexOf(draggedId)
    const targetIndex = visibleIds.indexOf(phraseId)
    if (sourceIndex < 0 || targetIndex < 0) {
      setDraggedPhraseId(null)
      setDragTargetPhraseId(null)
      return
    }
    const reorderedVisibleIds = [...visibleIds]
    reorderedVisibleIds.splice(sourceIndex, 1)
    reorderedVisibleIds.splice(targetIndex, 0, draggedId)
    const phraseIds = new Set(library.phrases.map((phrase) => phrase.id))
    const fullOrder = overlayPhraseOrder.filter((id, index, values) => phraseIds.has(id) && values.indexOf(id) === index)
    const includedIds = new Set(fullOrder)
    for (const phrase of orderedVisible) if (!includedIds.has(phrase.id)) { fullOrder.push(phrase.id); includedIds.add(phrase.id) }
    for (const phrase of library.phrases) if (!includedIds.has(phrase.id)) { fullOrder.push(phrase.id); includedIds.add(phrase.id) }
    const visibleSet = new Set(visibleIds)
    const visibleSlots = fullOrder.flatMap((id, index) => visibleSet.has(id) ? [index] : [])
    visibleSlots.forEach((slot, index) => { fullOrder[slot] = reorderedVisibleIds[index] })
    void saveOverlaySort('manual', fullOrder)
    setDraggedPhraseId(null)
    setDragTargetPhraseId(null)
    showToast('排序已保存，浮窗顺序已同步')
  }

  function handleCategoryDragStart(categoryId: string, event: ReactDragEvent<HTMLDivElement>) {
    if (!canEdit) {
      event.preventDefault()
      return
    }
    setDraggedCategoryId(categoryId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', categoryId)
  }

  function handleCategoryDragOver(categoryId: string, event: ReactDragEvent<HTMLDivElement>) {
    const draggedId = event.dataTransfer.getData('text/plain') || draggedCategoryId
    const draggedCategory = library.categories.find((item) => item.id === draggedId)
    const targetCategory = library.categories.find((item) => item.id === categoryId)
    if (!draggedCategory || !targetCategory || draggedCategory.scope !== targetCategory.scope) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (categoryId !== draggedCategoryId) setDragTargetCategoryId(categoryId)
  }

  function handleCategoryDrop(categoryId: string, event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault()
    const draggedId = event.dataTransfer.getData('text/plain') || draggedCategoryId
    const draggedCategory = library.categories.find((item) => item.id === draggedId)
    const targetCategory = library.categories.find((item) => item.id === categoryId)
    if (draggedCategory && targetCategory && draggedCategory.scope === targetCategory.scope && draggedCategory.id !== targetCategory.id) {
      setLibrary((current) => {
        const scopedCategories = current.categories.filter((item) => item.scope === draggedCategory.scope)
        const sourceIndex = scopedCategories.findIndex((item) => item.id === draggedCategory.id)
        const targetIndex = scopedCategories.findIndex((item) => item.id === targetCategory.id)
        if (sourceIndex < 0 || targetIndex < 0) return current
        const reordered = [...scopedCategories]
        const [movedCategory] = reordered.splice(sourceIndex, 1)
        reordered.splice(targetIndex, 0, movedCategory)
        let scopedIndex = 0
        return { ...current, categories: current.categories.map((item) => item.scope === draggedCategory.scope ? reordered[scopedIndex++] : item) }
      })
      showToast('分类顺序已保存')
    }
    setDraggedCategoryId(null)
    setDragTargetCategoryId(null)
  }

  async function toggleOverlayPinned() {
    const next = await window.kefuDesk?.setOverlayPinned(!overlayPinned)
    if (typeof next === 'boolean') {
      setOverlayPinned(next)
      showToast(next ? '浮窗已固定在桌面' : '浮窗已取消固定')
    }
  }
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus() }
      if (event.key === 'Escape' && overlayMode) void window.kefuDesk?.hideOverlay()
      const target = event.target as HTMLElement
      const editingText = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !overlayMode && !editingText && editor === null && categoryEditor === null && !syncSettingsOpen && !appSettingsOpen && !pendingJsonImport) {
        event.preventDefault()
        setSelected(visible.map((item) => item.id))
      }
      const shortcutModifier: ShortcutModifier | null = event.altKey && !event.ctrlKey && !event.metaKey ? 'alt' : event.ctrlKey && !event.altKey && !event.metaKey ? 'ctrl' : null
      if (shortcutModifier && !editingText && !pendingJsonImport && /^[1-9]$/.test(event.key)) {
        const phrase = visible.find((item) => item.shortcut === event.key && (item.shortcutModifier ?? 'alt') === shortcutModifier)
        if (phrase) { event.preventDefault(); void copyPhrase(phrase) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, editor, categoryEditor, syncSettingsOpen, appSettingsOpen, pendingJsonImport])
  function savePhrase(phrase: Phrase) {
    if (!canEdit) return showToast('当前设备只读，请在主电脑修改话术')
    setLibrary((current) => ({ ...current, phrases: current.phrases.some((item) => item.id === phrase.id) ? current.phrases.map((item) => item.id === phrase.id ? { ...phrase, updatedAt: Date.now() } : item) : [{ ...phrase, updatedAt: Date.now() }, ...current.phrases] }))
    setEditor(null); showToast('话术已保存')
  }
  async function copyPhrase(phrase: Phrase) {
    const images = phraseImages(phrase)
    const videos = phraseVideos(phrase)
    if (!phrase.text.trim() && images.length === 0 && videos.length === 0) {
      return showToast('这条话术没有可复制的内容')
    }
    if (window.kefuAndroid && videos.length > 0 && !phrase.text.trim() && images.length === 0) return showToast('安卓端暂不支持复制视频附件')
    try {
      const copied = await copyClipboardContent(phrase.text, images, videos, workspace)
      if (!copied) return showToast('复制失败，请重试')
    } catch {
      return showToast('复制失败，请检查剪贴板权限')
    }
    const contentName = videos.length && window.kefuAndroid ? '话术内容已复制，安卓端暂不支持复制视频附件' : videos.length ? (phrase.text.trim() || images.length ? '话术和视频附件' : '视频附件') : phrase.text.trim() && images.length ? '文字和图片' : images.length ? `${images.length} 张图片` : '文字'
    showToast(window.kefuAndroid && videos.length ? contentName : `${contentName}已复制，可回聊天窗口粘贴`)
    if (canEdit && overlaySortMode !== 'manual') setLibrary((current) => ({ ...current, phrases: current.phrases.map((item) => item.id === phrase.id ? { ...item, updatedAt: Date.now() } : item) }))
    if (overlayMode && !overlayPinned) window.setTimeout(() => void window.kefuDesk?.hideOverlay(), 2400)
  }
  function removePhrase(id: string) {
    if (!canEdit) return showToast('当前设备只读，请在主电脑删除话术')
    setLibrary((current) => ({ ...current, phrases: current.phrases.filter((item) => item.id !== id) }))
    setSelected((current) => current.filter((item) => item !== id)); showToast('话术已删除')
  }
  function toggleFavorite(id: string) {
    if (!canEdit) return showToast('当前设备只读，请在主电脑修改收藏')
    setLibrary((current) => ({ ...current, phrases: current.phrases.map((item) => item.id === id ? { ...item, favorite: !item.favorite } : item) }))
  }
  function saveCategory(category: Category) {
    if (!canEdit) return showToast('当前设备只读，请在主电脑修改分类')
    setLibrary((current) => ({ ...current, categories: current.categories.some((item) => item.id === category.id) ? current.categories.map((item) => item.id === category.id ? category : item) : [...current.categories, category] }))
    setCategoryEditor(null); setCategoryId(category.id); setScope(category.scope); showToast('分类已保存')
  }
  function deleteCategory(category: Category) {
    if (!canEdit) return showToast('当前设备只读，请在主电脑删除分类')
    setLibrary((current) => ({ categories: current.categories.filter((item) => item.id !== category.id), phrases: current.phrases.filter((item) => item.categoryId !== category.id) }))
    setCategoryId('all'); setCategoryEditor(null); showToast('分类及其中话术已删除')
  }
  async function exportLibrary(format: 'xlsx' | 'json') {
    if (format === 'json') {
      const jsonLibrary: LibraryData = { categories: library.categories, phrases: library.phrases.map(({ videos: _videos, ...phrase }) => phrase) }
      await deliverFile(JSON.stringify(jsonLibrary, null, 2), '客服宝话术备份.json', 'application/json')
    }
    else {
      const ExcelJS = await import('exceljs')
      const book = new ExcelJS.Workbook()
      const sheet = book.addWorksheet('话术库')
      sheet.columns = [
        { header: '标题', key: 'title', width: 24 }, { header: '内容', key: 'text', width: 60 },
        { header: '分类', key: 'category', width: 18 }, { header: '范围', key: 'scope', width: 14 },
         { header: '标签', key: 'tags', width: 24 }, { header: '快捷键前缀', key: 'shortcutModifier', width: 14 }, { header: '快捷键', key: 'shortcut', width: 12 },
      ]
      sheet.getRow(1).font = { bold: true, color: { argb: 'FF203640' } }
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5F0' } }
      sheet.addRows(library.phrases.map((phrase) => ({
        title: phrase.title, text: phrase.text,
         category: library.categories.find((item) => item.id === phrase.categoryId)?.name ?? '',
         scope: library.categories.find((item) => item.id === phrase.categoryId)?.scope ?? '',
          tags: phrase.tags.join('，'), shortcutModifier: phrase.shortcut ? (phrase.shortcutModifier ?? 'alt').toUpperCase() : '', shortcut: phrase.shortcut ?? '',
      })))
      const buffer = await book.xlsx.writeBuffer()
      await deliverFile(buffer, '客服宝话术库.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    }
    const videoCount = library.phrases.reduce((count, phrase) => count + phraseVideos(phrase).length, 0)
    showToast(format === 'json' && videoCount ? `JSON 已导出；不含 ${videoCount} 个视频，完整备份请选 ZIP` : '话术库已导出')
  }
  async function exportFullBackup() {
    try {
      const { default: JSZip } = await import('jszip')
      const videos = new Map<string, VideoAttachment>()
      for (const phrase of library.phrases) {
        for (const video of phraseVideos(phrase)) {
          const existing = videos.get(video.id)
          if (existing && !sameVideoAttachment(existing, video)) throw new Error(`视频“${video.name}”的附件信息不一致`)
          videos.set(video.id, video)
        }
      }
      const zip = new JSZip()
      zip.file('客服宝话术备份.json', JSON.stringify({ format: 'kefu-desk-backup', schemaVersion: 1, library }))
      for (const video of videos.values()) {
        if (!window.kefuDesk) throw new Error('视频完整备份仅支持桌面版')
        const bytes = await window.kefuDesk.readVideo(video.id, video.name, video.size, video.sha256, workspace)
        if (!bytes || bytes.byteLength !== video.size) throw new Error(`无法读取视频“${video.name}”，请先同步云端工作区后重试`)
        zip.file(`videos/${video.id}`, bytes, { binary: true })
      }
      const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      await deliverFile(archive, '客服宝话术完整备份.zip', 'application/zip')
      showToast(`完整备份已导出${videos.size ? `，包含 ${videos.size} 个视频` : ''}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ZIP 备份失败，请重试')
    }
  }
  async function importLibrary(file: File) {
    if (!canEdit) { showToast('当前设备只读，请在主电脑导入话术'); if (importRef.current) importRef.current.value = ''; return }
    try {
      const extension = file.name.toLowerCase()
      if (extension.endsWith('.zip')) {
        const { default: JSZip } = await import('jszip')
        const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true })
        const manifestFile = zip.file('客服宝话术备份.json')
        if (!manifestFile) throw new Error('ZIP 中未找到客服宝话术备份清单')
        const manifest = JSON.parse(await manifestFile.async('text'))
        if (manifest?.format !== 'kefu-desk-backup' || manifest.schemaVersion !== 1) throw new Error('ZIP 备份格式或版本不受支持')
        const data = normalizeLibrary(manifest.library)
        if (!data) throw new Error('文件格式不正确')
        const sourcePhrases = Array.isArray(manifest.library?.phrases) ? manifest.library.phrases : []
        const videos = new Map<string, VideoAttachment>()
        for (const phrase of sourcePhrases) {
          if (phrase?.videos !== undefined && !Array.isArray(phrase.videos)) throw new Error('备份中的视频附件清单格式不正确')
          for (const video of phrase?.videos ?? []) {
            if (!isVideoAttachment(video)) throw new Error('备份中存在无效视频信息')
            const existing = videos.get(video.id)
            if (existing && !sameVideoAttachment(existing, video)) throw new Error(`视频“${video.name}”的附件信息不一致`)
            videos.set(video.id, video)
          }
        }
        for (const video of videos.values()) {
          const entry = zip.file(`videos/${video.id}`)
          if (!entry) throw new Error(`ZIP 中缺少视频附件“${video.name}”`)
          const bytes = await entry.async('uint8array')
          if (bytes.byteLength !== video.size) throw new Error(`视频“${video.name}”的文件大小不匹配`)
          if (await sha256Hex(bytes) !== video.sha256) throw new Error(`视频“${video.name}”校验失败`)
        }
        if (!window.kefuDesk) throw new Error('视频完整恢复仅支持桌面版')
        for (const video of videos.values()) {
          const entry = zip.file(`videos/${video.id}`)!
          const bytes = await entry.async('uint8array')
          await window.kefuDesk.writeVideo({ id: video.id, name: video.name, mime: video.mime, sha256: video.sha256, data: bytes.slice().buffer as ArrayBuffer }, workspace)
        }
        setLibrary(data); showToast(`已完整恢复 ${data.phrases.length} 条话术和 ${videos.size} 个视频`)
      } else if (extension.endsWith('.json')) {
        const parsed = JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
        const data = normalizeLibrary(parsed)
        if (!data) throw new Error('文件格式不正确')
        const videoReferences = parsed.phrases.reduce((count: number, phrase: Partial<Phrase> | null) => count + (Array.isArray(phrase?.videos) ? phrase.videos.length : 0), 0)
        setPendingJsonImport({ filename: file.name, data, workspace, videoReferences })
      } else {
        const ExcelJS = await import('exceljs')
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(await file.arrayBuffer())
        const sheet = workbook.worksheets[0]
        if (!sheet) throw new Error('表格里没有工作表')
        const headers = new Map<string, number>()
        sheet.getRow(1).eachCell((cell, column) => headers.set(String(cell.text).trim().toLocaleLowerCase(), column))
        const readCell = (row: Row, keys: string[]) => {
          const column = keys.map((key) => headers.get(key)).find((value) => value !== undefined)
          return column === undefined ? '' : row.getCell(column).text.trim()
        }
        const parsed: { title: string; text: string; category: string; tags: string[]; shortcut: string; shortcutModifier: ShortcutModifier }[] = []
        sheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return
           const title = readCell(row, ['标题', 'title'])
           const text = readCell(row, ['内容', '话术', 'text'])
           if (title || text) {
            const shortcutText = readCell(row, ['快捷键', 'shortcut'])
            const shortcutMatch = shortcutText.match(/^(?:(ctrl|control|alt)\s*\+\s*)?([1-9])$/i)
            const prefixText = readCell(row, ['快捷键前缀', 'shortcut modifier', 'modifier'])
            const shortcutModifier: ShortcutModifier = /^(ctrl|control)$/i.test(prefixText) || (!prefixText && /^(ctrl|control)$/i.test(shortcutMatch?.[1] ?? '')) ? 'ctrl' : 'alt'
            parsed.push({
              title, text,
              category: readCell(row, ['分类', 'category']) || '导入话术',
              tags: readCell(row, ['标签', 'tags']).split(/[，,]/).map((item: string) => item.trim()).filter(Boolean),
              shortcut: shortcutMatch?.[2] ?? '',
              shortcutModifier,
            })
          }
        })
        if (!parsed.length) throw new Error('表格中没有可导入的话术')
        const next = { categories: [...library.categories], phrases: [...library.phrases] }
        const map = new Map(next.categories.map((item) => [item.name, item.id]))
        for (const row of parsed) {
          let categoryId = map.get(row.category)
          if (!categoryId) {
            categoryId = uid(); next.categories.push({ id: categoryId, name: row.category, scope: 'private', color: colors[next.categories.length % colors.length] }); map.set(row.category, categoryId)
          }
           next.phrases.push({ id: uid(), title: row.title || row.text.slice(0, 18), text: row.text, categoryId, tags: row.tags, shortcut: row.shortcut, shortcutModifier: row.shortcutModifier, updatedAt: Date.now() })
        }
        setLibrary(next); showToast(`已导入 ${parsed.length} 条话术`)
      }
    } catch (error) { showToast(error instanceof Error ? error.message : '文件读取失败') }
    if (importRef.current) importRef.current.value = ''
  }
  function confirmJsonImport(selectedIndices: number[]) {
    if (!pendingJsonImport || pendingJsonImport.workspace !== workspace || !canEdit) return showToast('工作区未就绪或当前设备只读，无法新增话术')
    const incoming = pendingJsonImport.data
    const result = mergeJsonImport(library, incoming, selectedIndices)
    if (result.addedCount > 0) setLibrary((current) => mergeJsonImport(current, incoming, selectedIndices).library)
    setPendingJsonImport(null)
    showToast(result.addedCount ? `已新增 ${result.addedCount} 条话术${result.categoryCount ? `、${result.categoryCount} 个分类` : ''}，原有话术全部保留` : '没有需要新增的内容，原有话术保持不变')
  }
  async function bulkCopy() {
    const items = visible.filter((item) => selected.includes(item.id))
    const text = items.map((item) => item.text).filter(Boolean).join('\n\n')
    const images = items.flatMap(phraseImages)
    const videos = items.flatMap(phraseVideos)
    if (!text && images.length === 0 && videos.length === 0) {
      return showToast('所选内容没有可复制的内容')
    }
    if (window.kefuAndroid && videos.length > 0 && !text && images.length === 0) return showToast('安卓端暂不支持复制视频附件')
    try {
      const copied = await copyClipboardContent(text, images, videos, workspace)
      if (!copied) return showToast('复制失败，请重试')
    } catch {
      return showToast('复制失败，请检查剪贴板权限')
    }
    showToast(window.kefuAndroid && videos.length ? `已合并复制 ${items.length} 条话术的文字和图片；安卓端暂不支持视频附件` : `已合并复制 ${items.length} 条话术${videos.length ? `及 ${videos.length} 个视频附件，可粘贴发送` : ''}`); setSelected([])
  }
  function bulkDelete() {
    if (!canEdit) return showToast('当前设备只读，请在主电脑删除话术')
    const items = visible.filter((item) => selected.includes(item.id))
    if (items.length === 0) return showToast('请先选择要删除的话术')
    if (!window.confirm(`确定删除选中的 ${items.length} 条话术吗？此操作无法撤销。`)) return
    const deletedIds = new Set(items.map((item) => item.id))
    setLibrary((current) => ({ ...current, phrases: current.phrases.filter((item) => !deletedIds.has(item.id)) }))
    setSelected((current) => current.filter((id) => !deletedIds.has(id)))
    showToast(`已删除 ${items.length} 条话术`)
  }
  const heading = favoritesOnly ? '收藏话术' : library.categories.find((item) => item.id === categoryId)?.name ?? ({ all: '全部话术', company: '公司共享', group: '小组共享', private: '私人话术' }[scope])
  const total = library.phrases.length
  const favoriteCount = library.phrases.filter((item) => item.favorite).length
  const canEdit = ready && (workspace === 'local' || (syncAccessReady && syncConfig.configured && syncStatus.canEdit))
  const workspaceSubtitle = workspace === 'local'
    ? '独立保存在本机'
    : !syncConfig.configured
      ? '尚未连接坚果云'
      : syncStatus.deviceRole === 'readonly'
        ? '坚果云 · 只读设备'
        : '坚果云 · 主电脑'
  return <div className={`app-shell${dark ? ' theme-dark' : ''}${overlayMode ? ' overlay-mode' : ''}`}>
    {overlayMode ? <main className="overlay-shell">
      <header className="overlay-header"><div className="brand-mini"><span className="brand-mark"><MessageCircle size={15} /></span><b>快回</b></div><span className="overlay-hint"><Keyboard size={13} /> Ctrl ⇧ Space</span><div className="overlay-window-actions"><button className="icon-button overlay-size-button" onClick={() => void window.kefuDesk?.resizeOverlay(-1)} aria-label="缩小浮窗" title="缩小浮窗"><Minus size={14} /></button><button className="icon-button overlay-size-button" onClick={() => void window.kefuDesk?.resizeOverlay(1)} aria-label="放大浮窗" title="放大浮窗"><Plus size={14} /></button><button className={`icon-button pin-button${overlayPinned ? ' is-pinned' : ''}`} onClick={() => void toggleOverlayPinned()} aria-label={overlayPinned ? '取消固定浮窗' : '固定浮窗'} title={overlayPinned ? '取消固定浮窗' : '固定浮窗'}>{overlayPinned ? <Pin size={16} /> : <PinOff size={16} />}</button><button className="icon-button" onClick={() => void window.kefuDesk?.hideOverlay()} aria-label="关闭" title="关闭"><X size={17} /></button></div></header>
      <div className="overlay-search"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜话术 / 拼音首字母" /><kbd>Esc</kbd></div>
      <OverlayCategories categories={library.categories} categoryId={categoryId} onSelect={(item) => { if (!item) { setCategoryId('all'); return } setCategoryId(item.id); setScope(item.scope) }} />
      <div className="overlay-sort-bar" role="group" aria-label="浮窗话术排序"><span>排序</span><button type="button" className={overlaySortMode === 'recent' ? 'active' : ''} aria-pressed={overlaySortMode === 'recent'} disabled={!ready || !overlaySortReady} onClick={() => selectOverlaySortMode('recent')}>最近使用</button><button type="button" className={overlaySortMode === 'manual' ? 'active' : ''} aria-pressed={overlaySortMode === 'manual'} disabled={!ready || !overlaySortReady} onClick={() => selectOverlaySortMode('manual')}><GripVertical size={11} />固定顺序</button>{overlaySortMode === 'manual' && <small>拖动卡片调整</small>}</div>
      <div className={`overlay-list${overlaySortMode === 'manual' ? ' manual-sort' : ''}`}>{overlayVisible.length ? overlayVisible.map((phrase, index) => <PhraseCard key={phrase.id} phrase={phrase} category={library.categories.find((item) => item.id === phrase.categoryId)} compact index={index} onCopy={copyPhrase} onPreviewVideo={(video) => void openVideoPreview(video)} onEdit={() => undefined} onFavorite={toggleFavorite} onDelete={() => undefined} selected={false} onSelect={() => undefined} readOnly={!canEdit} draggable={overlaySortMode === 'manual' && ready && overlaySortReady} dragging={draggedPhraseId === phrase.id} dropTarget={dragTargetPhraseId === phrase.id} onDragStart={overlaySortMode === 'manual' && ready && overlaySortReady ? (event) => handlePhraseDragStart(phrase.id, event) : undefined} onDragOver={overlaySortMode === 'manual' && ready && overlaySortReady ? (event) => handlePhraseDragOver(phrase.id, event) : undefined} onDrop={overlaySortMode === 'manual' && ready && overlaySortReady ? (event) => handlePhraseDrop(phrase.id, event, overlayVisible) : undefined} onDragEnd={() => { setDraggedPhraseId(null); setDragTargetPhraseId(null) }} />) : <EmptyState searching={Boolean(query)} onAdd={() => undefined} canAdd={false} />}</div>
      <footer className="overlay-footer"><span><kbd>Alt / Ctrl + 1–9</kbd> 快捷复制</span><span>复制后回聊天窗口粘贴</span></footer>{toast && <Toast message={toast} />}
    </main> : <div className="workspace">
      <aside className="sidebar">
        <div className="brand-lockup"><span className="brand-mark"><MessageCircle size={18} fill="currentColor" /></span><div><strong>快回</strong><small>客服工作台</small></div><span className="brand-version">DESK</span></div>
        <div className="workspace-switcher" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWorkspaceMenuOpen(false) }}>
          <button className="workspace-switch" aria-expanded={workspaceMenuOpen} aria-haspopup="menu" onClick={() => setWorkspaceMenuOpen((open) => !open)}>
            <div className={`workspace-avatar${workspace === 'cloud' ? ' cloud-avatar' : ''}`}>{workspace === 'cloud' ? <Cloud size={16} /> : <HardDrive size={16} />}</div>
            <div className="workspace-name"><strong>{workspace === 'local' ? '本机工作区' : '云端工作区'}</strong><span>{workspaceSubtitle}</span></div><ChevronDown size={15} />
          </button>
          {workspaceMenuOpen && <div className="workspace-menu" role="menu" aria-label="选择工作区">
            <button className={`workspace-option${workspace === 'local' ? ' selected' : ''}`} role="menuitem" onClick={() => void switchWorkspace('local')}><HardDrive size={16} /><span><strong>本机工作区</strong><small>独立保存在这台电脑</small></span>{workspace === 'local' && <Check size={15} />}</button>
            <button className={`workspace-option${workspace === 'cloud' ? ' selected' : ''}`} role="menuitem" onClick={() => void switchWorkspace('cloud')}><Cloud size={16} /><span><strong>云端工作区</strong><small>{syncConfig.configured ? '坚果云 · 与本机数据分开' : '需要连接坚果云'}</small></span>{workspace === 'cloud' && <Check size={15} />}</button>
          </div>}
        </div>
        <div className="sidebar-scroll">
          <div className="nav-section-label">工作台</div>
          <button className={`nav-item${!favoritesOnly && categoryId === 'all' && scope === 'all' ? ' active' : ''}`} onClick={() => { setFavoritesOnly(false); setScope('all'); setCategoryId('all') }}><LayoutGrid size={16} /><span>全部话术</span><span className="nav-count">{total}</span></button>
          <button className={`nav-item${favoritesOnly ? ' active' : ''}`} onClick={() => { setFavoritesOnly(true); setCategoryId('all') }}><Star size={16} /><span>我的收藏</span><span className="nav-count">{favoriteCount}</span></button>
          <div className="category-heading"><span>话术分类</span><button className="small-icon-button" onClick={() => setCategoryEditor('new')} aria-label="新建分类" disabled={!canEdit}><Plus size={15} /></button></div>
          <div className="scope-picker">{(['company', 'group', 'private'] as Scope[]).map((item) => <button key={item} className={scope === item ? 'chosen' : ''} onClick={() => { setScope(scope === item ? 'all' : item); setCategoryId('all'); setFavoritesOnly(false) }}>{item === 'private' ? '我的' : item === 'group' ? '小组' : '公司'}</button>)}</div>
          {(['company', 'group', 'private'] as Scope[]).map((group) => grouped[group].length > 0 && <div className="category-group" key={group}><div className="category-group-label"><span className={`scope-dot ${group}`} />{scopeNames[group]}</div>
            {grouped[group].map((item) => <div className={`category-row${categoryId === item.id ? ' selected' : ''}${canEdit && grouped[group].length > 1 ? ' is-draggable' : ''}${draggedCategoryId === item.id ? ' is-dragging' : ''}${dragTargetCategoryId === item.id ? ' is-drop-target' : ''}`} key={item.id} draggable={canEdit && grouped[group].length > 1} title={canEdit && grouped[group].length > 1 ? '按住鼠标左键拖动以调整分类顺序' : undefined} onDragStart={(event) => handleCategoryDragStart(item.id, event)} onDragOver={(event) => handleCategoryDragOver(item.id, event)} onDrop={(event) => handleCategoryDrop(item.id, event)} onDragEnd={() => { setDraggedCategoryId(null); setDragTargetCategoryId(null) }}><button className="category-select" onClick={() => { setFavoritesOnly(false); setScope(item.scope); setCategoryId(item.id) }}>{canEdit && grouped[group].length > 1 && <span className="category-drag-handle" aria-hidden="true"><GripVertical size={12} /></span>}<span className="category-color" style={{ backgroundColor: item.color }} /><span className="category-name">{item.name}</span><span className="category-count">{library.phrases.filter((phrase) => phrase.categoryId === item.id).length}</span></button><button className="category-more" onClick={() => setCategoryEditor(item)} aria-label={`编辑${item.name}`} disabled={!canEdit}><MoreHorizontal size={15} /></button></div>)}
          </div>)}
          <div className="sidebar-note"><div className="note-icon">{workspace === 'local' ? <HardDrive size={16} /> : <Cloud size={16} />}</div><div><strong>{workspace === 'local' ? '本机工作区' : !syncConfig.configured ? '未连接坚果云' : syncStatus.deviceRole === 'readonly' ? '云端只读设备' : '坚果云主电脑'}</strong><span>{workspace === 'local' ? '独立保存，不与云端混用' : !syncConfig.configured ? '连接坚果云后读取云端话术' : syncStatus.deviceRole === 'readonly' ? '可查看和复制，修改请在主电脑进行' : '云端话术与本机工作区分开保存'}</span></div>{workspace === 'cloud' && !syncConfig.configured && <button className="workspace-connect-link" onClick={() => void openSyncSettings()} aria-label="连接坚果云"><ArrowUpRight size={14} /></button>}</div>
        </div>
        <div className="sidebar-bottom"><div className="profile-avatar">林</div><div className="profile-copy"><strong>本地客服</strong><span>离线可用</span></div><button className="small-icon-button" onClick={() => setDark(!dark)} aria-label="切换主题">{dark ? <Sun size={16} /> : <Moon size={16} />}</button><button className="small-icon-button" onClick={() => showToast('浮窗：Ctrl + Shift + Space；话术快捷复制：Alt / Ctrl + 1–9')} aria-label="快捷键帮助"><Keyboard size={16} /></button></div>
      </aside>
      <main className="main-panel">
         <header className="topbar"><div className="breadcrumb"><span>{workspace === 'local' ? '本机工作区' : '云端工作区'}</span><span className="crumb-divider">/</span><strong>{heading}</strong></div><div className="top-actions"><button className="hotkey-pill" onClick={() => showToast(window.kefuAndroid ? '点击蓝发鲸鱼宠物呼出话术浮窗' : '按 Ctrl + Shift + Space 可随时呼出浮窗')}><Command size={13} /><span>全局浮窗</span><kbd>Ctrl ⇧ Space</kbd></button><span className="topbar-divider" /><div className="online-state"><span />{workspace === 'local' ? '本机独立保存' : syncConfig.configured ? syncStatus.syncing ? '正在同步坚果云' : '坚果云工作区' : '云端尚未连接'}</div><button type="button" className="top-settings-button" onClick={() => { setAutoLaunchError(''); if (window.kefuAndroid) void window.kefuAndroid.getPetStatus().then((status) => { setPetPermissionGranted(status.permissionGranted); setPetRunning(status.running) }).catch(() => {}); setAppSettingsOpen(true) }} aria-label="设置" title="设置"><Settings size={17} /></button></div></header>
        <div className="content-area">
          {workspace === 'cloud' && !syncConfig.configured && <div className="workspace-connect-banner"><div><Cloud size={17} /><span><strong>云端工作区尚未连接坚果云</strong><small>此处只显示本设备缓存的云端库；连接后才会与坚果云同步。</small></span></div><button className="button-primary" onClick={() => void openSyncSettings()}>连接坚果云</button></div>}
          {!overlayMode && <div className="cloud-sync-strip"><div className="cloud-sync-strip-copy"><Cloud size={16} /><span><strong>{syncStatus.syncing ? '正在同步坚果云' : syncConfig.configured ? syncStatus.deviceRole === 'readonly' ? '只读设备 · 跟随主电脑' : '主电脑 · 坚果云同步已连接' : '连接坚果云，在多台设备间同步话术'}</strong><small>{syncStatus.error ? syncStatus.error : syncStatus.conflictCount ? syncStatus.message ?? '已以坚果云为准同步' : syncStatus.lastSyncAt ? '上次同步：' + new Date(syncStatus.lastSyncAt).toLocaleString() : '云端优先：软件改动自动上传，云端改动自动拉取'}</small></span></div><div className="cloud-sync-strip-actions"><button className="button-quiet" onClick={() => void openSyncSettings()}>{syncConfig.configured ? '同步设置' : '连接坚果云'}</button>{syncConfig.configured && <button className="button-primary" onClick={() => void syncNowManually()} disabled={syncBusy || syncStatus.syncing}>{syncBusy || syncStatus.syncing ? '同步中…' : '立即同步'}</button>}</div></div>}
          <section className="page-intro"><div className="intro-copy"><div className="eyebrow"><span className="eyebrow-line" /> REPLY LIBRARY <span className="eyebrow-dot">·</span> {String(total).padStart(2, '0')} 条内容</div><h1>{heading}<span className="title-period">.</span></h1><p>把好回答存下来，让每一次服务都更从容。</p></div><div className="intro-mark"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="intro-bubble"><MessageCircle size={32} /><span>✓</span></div><span className="orbit-label">QUICK<br />REPLY</span></div></section>
          <section className="action-bar">
            <div className="search-box"><Search size={17} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索话术、标签或拼音首字母…" /><kbd>Ctrl K</kbd>{query && <button className="clear-search" onClick={() => setQuery('')} aria-label="清空搜索"><X size={14} /></button>}</div>
            <div className="action-buttons">
              <button className="button-quiet" onClick={() => importRef.current?.click()} disabled={!canEdit}><Upload size={15} /><span>导入</span></button>
              <input ref={importRef} className="hidden-input" type="file" accept=".xlsx,.json,.zip" disabled={!canEdit} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importLibrary(file) }} />
              <div className={`export-menu${exportMenuOpen ? ' open' : ''}`} ref={exportMenuRef}>
                <button type="button" className="button-quiet" aria-haspopup="menu" aria-expanded={exportMenuOpen} onClick={() => setExportMenuOpen((open) => !open)}><Download size={15} /><span>导出</span><ChevronDown size={13} /></button>
                {exportMenuOpen && <div className="export-options" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setExportMenuOpen(false); void exportLibrary('xlsx') }}><FileSpreadsheet size={15} />Excel 表格</button>
                  <button type="button" role="menuitem" onClick={() => { setExportMenuOpen(false); void exportLibrary('json') }}><Download size={15} />JSON 备份</button>
                  <button type="button" role="menuitem" onClick={() => { setExportMenuOpen(false); void exportFullBackup() }}><Archive size={15} />ZIP 完整备份（含视频）</button>
                </div>}
              </div>
              <button className="button-primary" onClick={() => setEditor('new')} disabled={!canEdit}><Plus size={16} /><span>新建话术</span></button>
            </div>
          </section>
          <section className="results-toolbar"><div className="results-meta"><span className="result-count">{visible.length}</span><span>条话术</span>{query && <span className="query-chip">匹配“{query}”<button onClick={() => setQuery('')}><X size={11} /></button></span>}</div><div className="results-tools">{selectedVisible.length > 0 && <><button className="bulk-copy" onClick={() => void bulkCopy()}><Copy size={14} />合并复制 {selectedVisible.length} 条</button><button className="bulk-delete" onClick={bulkDelete} disabled={!canEdit} title={canEdit ? '删除选中的话术' : '只读设备不能删除话术'}><Trash2 size={14} />删除 {selectedVisible.length} 条</button><button className="clear-selection" onClick={() => setSelected([])}>取消选择</button></>}<button className={`sort-button${manualMainSort ? ' manual-sort-active' : ''}`} title="按住鼠标左键拖动话术卡片可调整顺序" onClick={() => { if (manualMainSort) { setManualMainSort(false); setSortRecent(true) } else setSortRecent((current) => !current) }}><ArrowDownWideNarrow size={15} /><span>{manualMainSort ? '手动排序' : sortRecent ? '最近使用' : '按名称'}</span><ChevronDown size={13} /></button><button className="view-filter" onClick={() => { setScope(scope === 'all' ? 'company' : 'all'); setCategoryId('all') }}><Users size={15} /><span>{scope === 'all' ? '所有范围' : scopeNames[scope]}</span></button></div></section>
          {visible.length ? <div className="phrase-grid">{visible.map((phrase, index) => <PhraseCard key={phrase.id} phrase={phrase} category={library.categories.find((item) => item.id === phrase.categoryId)} index={index} onCopy={copyPhrase} onPreviewVideo={(video) => void openVideoPreview(video)} onEdit={() => setEditor(phrase)} onFavorite={toggleFavorite} onDelete={removePhrase} selected={selected.includes(phrase.id)} onSelect={() => setSelected((current) => current.includes(phrase.id) ? current.filter((id) => id !== phrase.id) : [...current, phrase.id])} readOnly={!canEdit} draggable={ready && overlaySortReady && visible.length > 1} dragging={draggedPhraseId === phrase.id} dropTarget={dragTargetPhraseId === phrase.id} onDragStart={ready && overlaySortReady && visible.length > 1 ? (event) => handlePhraseDragStart(phrase.id, event) : undefined} onDragOver={ready && overlaySortReady && visible.length > 1 ? (event) => handlePhraseDragOver(phrase.id, event) : undefined} onDrop={ready && overlaySortReady && visible.length > 1 ? (event) => handlePhraseDrop(phrase.id, event, visible) : undefined} onDragEnd={() => { setDraggedPhraseId(null); setDragTargetPhraseId(null) }} />)}</div> : <EmptyState searching={Boolean(query || favoritesOnly)} onAdd={() => setEditor('new')} canAdd={canEdit} />}
          <footer className="content-footer"><span><span className="footer-led" />{workspace === 'local' ? '本机工作区 · 独立保存' : syncConfig.configured ? '云端工作区 · 坚果云同步' : '云端缓存 · 尚未连接坚果云'}</span><span>建议定期导出备份 <span className="footer-separator">·</span> <button onClick={() => exportFullBackup()}>完整备份 ZIP <ArrowUpRight size={12} /></button></span></footer>
        </div>
      </main>
    </div>}
    {appSettingsOpen && !overlayMode && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !autoLaunchBusy && !petBusy) setAppSettingsOpen(false) }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="app-settings-title">
      <div className="modal-heading"><div><div className="modal-eyebrow">APP SETTINGS</div><h2 id="app-settings-title">设置</h2><p>{window.kefuAndroid ? '管理宠物悬浮窗和坚果云云端工作区。' : '管理客服宝的桌面运行选项。'}</p></div><button type="button" className="icon-button" onClick={() => setAppSettingsOpen(false)} disabled={autoLaunchBusy || petBusy} aria-label="关闭设置"><X size={18} /></button></div>
      {window.kefuAndroid ? <>
        <div className="startup-setting-row"><div className="startup-setting-copy"><img className="pet-setting-avatar" src="/pet-avatar.png" alt="蓝发鲸鱼宠物" /><span><strong>桌面宠物悬浮窗</strong><small>{petRunning ? '已开启 · 点击宠物显示话术' : petPermissionGranted ? '已授权 · 可随时开启或关闭' : '需要允许显示在其他应用上层'}</small></span></div><button type="button" className={`settings-switch${petRunning ? ' is-enabled' : ''}`} role="switch" aria-checked={petRunning} aria-label="桌面宠物悬浮窗" disabled={petBusy} onClick={() => void togglePet()}><span /></button></div>
        <div className="settings-note">宠物使用你提供的蓝发鲸鱼形象。开启后可拖动宠物调整位置，点击即可呼出话术；关闭应用窗口后宠物仍会保留，需在此关闭。</div>
      </> : <>
        <div className="startup-setting-row"><div className="startup-setting-copy"><span className="startup-setting-icon"><Settings size={17} /></span><span><strong>开机自启动</strong><small>登录 Windows 后自动启动客服宝</small></span></div><button type="button" className={`settings-switch${autoLaunchEnabled ? ' is-enabled' : ''}`} role="switch" aria-checked={autoLaunchEnabled} aria-label="开机自启动" disabled={!autoLaunchSupported || autoLaunchBusy} onClick={() => void toggleAutoLaunch()}><span /></button></div>
        <div className="settings-note">{autoLaunchSupported ? '开关会立即生效，无需重启电脑；关闭后可随时再次开启。' : '此功能仅在 Windows 桌面安装版中可用。'}</div>
      </>}
      {autoLaunchError && <div className="form-error">{autoLaunchError}</div>}
      <div className="modal-footer"><span><ShieldCheck size={13} />{window.kefuAndroid ? '宠物悬浮窗由 Android 系统权限控制' : '仅修改当前 Windows 用户的启动设置'}</span><div><button type="button" className="button-quiet" onClick={() => setAppSettingsOpen(false)} disabled={autoLaunchBusy || petBusy}>关闭</button></div></div>
    </section></div>}
    {syncSettingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !syncBusy) setSyncSettingsOpen(false) }}><form className="cloud-sync-modal" onSubmit={(event) => void saveSyncSettings(event)}>
      <div className="modal-heading"><div><div className="modal-eyebrow">CLOUD SYNC</div><h2>坚果云同步</h2><p>在多台设备间同步话术、分类和图片附件。</p></div><button type="button" className="icon-button" onClick={() => setSyncSettingsOpen(false)} disabled={syncBusy}><X size={18} /></button></div>
      <div className="sync-info-card"><Cloud size={17} /><div><strong>{syncConfig.configured ? syncStatus.deviceRole === 'readonly' ? '已连接 · 本设备只读' : '已连接 · 本设备为主电脑' : '坚果云设备同步'}</strong><span>{syncStatus.syncing ? '正在验证并同步最新内容…' : syncStatus.conflictCount ? syncStatus.message ?? '云端版本优先' : syncStatus.lastSyncAt ? '上次同步：' + new Date(syncStatus.lastSyncAt).toLocaleString() : '坚果云是云端工作区主库；软件改动自动上传'}</span></div></div>
      <label className="field-label">WebDAV 地址<input value={syncUrl} onChange={(event) => setSyncUrl(event.target.value)} placeholder="https://dav.jianguoyun.com/dav/" autoComplete="url" /></label>
      <label className="field-label">坚果云账号邮箱<input type="email" value={syncUsername} onChange={(event) => setSyncUsername(event.target.value)} placeholder="坚果云登录邮箱" autoComplete="username" /></label>
      <label className="field-label">第三方应用密码<span>{syncConfig.configured ? '留空则保留已保存密码' : '不是坚果云登录密码'}</span><input type="password" value={syncPassword} onChange={(event) => setSyncPassword(event.target.value)} placeholder={syncConfig.configured ? '已安全保存；重新输入可更换' : '在坚果云安全选项中创建'} autoComplete="new-password" /></label>
      {window.kefuAndroid ? <div className="mobile-sync-role startup-setting-row"><div className="startup-setting-copy"><span className="startup-setting-icon"><ShieldCheck size={17} /></span><span><strong>安卓设备：只读</strong><small>可查看、搜索和复制；编辑请在主电脑完成</small></span></div></div> : <label className="field-label">本设备权限<select value={syncConfig.deviceRole} onChange={(event) => setSyncConfig((current) => ({ ...current, deviceRole: event.target.value as SyncDeviceRole }))}><option value="primary">主电脑：可新增、编辑和删除</option><option value="readonly">其他设备：只读查看和复制</option></select></label>}
      <div className="sync-security-note"><ShieldCheck size={14} /><span>坚果云是云端工作区的主库：软件改动自动上传，云端改动同步后覆盖本机云端缓存；同时发生冲突时以云端为准，并备份本机副本。主设备标记和只读限制由客服宝应用执行；这不是坚果云服务器端的团队 ACL。</span></div>
      {syncError && <div className="form-error">{syncError}</div>}{syncStatus.error && !syncError && <div className="form-error">{syncStatus.error}</div>}
      <div className="modal-footer"><span><ShieldCheck size={13} />数据会保存到坚果云目录：客服宝</span><div>{syncConfig.configured && <button type="button" className="disconnect-sync-button" onClick={() => void disconnectCloudSync()} disabled={syncBusy}>断开</button>}<button type="button" className="button-quiet" onClick={() => setSyncSettingsOpen(false)} disabled={syncBusy}>取消</button><button type="submit" className="button-primary" disabled={syncBusy}>{syncBusy ? '连接中…' : syncConfig.configured ? '保存并同步' : '连接并同步'}</button></div></div>
    </form></div>}
    {pendingJsonImport && jsonImportPreview && !overlayMode && <JsonImportDialog filename={pendingJsonImport.filename} preview={jsonImportPreview} videoReferences={pendingJsonImport.videoReferences} canConfirm={canEdit} onCancel={() => setPendingJsonImport(null)} onConfirm={confirmJsonImport} />}
    {canEdit && editor !== null && <PhraseEditor key={editor === 'new' ? 'new' : editor.id} categories={library.categories} initial={editor === 'new' ? null : editor} workspace={workspace} cloudSync={workspace === 'cloud' && syncConfig.configured} onClose={() => setEditor(null)} onSave={savePhrase} onPreviewVideo={(video) => void openVideoPreview(video)} />}
    {videoPreviewBusy && <div className="video-loading-indicator"><span />正在读取视频…</div>}
    {videoPreview && <div className="modal-backdrop video-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeVideoPreview() }}><section className="video-preview-modal" role="dialog" aria-modal="true" aria-label={`播放视频 ${videoPreview.video.name}`}><div className="video-preview-heading"><div><strong>{videoPreview.video.name}</strong><span>{formatFileSize(videoPreview.video.size)}</span></div><button type="button" className="video-reveal-button" onClick={() => void revealVideo(videoPreview.video)}><FolderOpen size={14} />在文件夹显示</button><button type="button" className="icon-button" onClick={closeVideoPreview} aria-label="关闭视频预览"><X size={18} /></button></div><video controls autoPlay preload="metadata" src={videoPreview.url} /></section></div>}
    {canEdit && categoryEditor !== null && <CategoryEditor key={categoryEditor === 'new' ? 'new-category' : categoryEditor.id} initial={categoryEditor === 'new' ? null : categoryEditor} onClose={() => setCategoryEditor(null)} onSave={saveCategory} onDelete={deleteCategory} />}
    {toast && !overlayMode && <Toast message={toast} />}{!ready && <div className="loading-indicator"><span />正在打开{workspace === 'local' ? '本机' : '云端'}工作区…</div>}
  </div>
}

function PhraseCard({ phrase, category, compact = false, index, onCopy, onPreviewVideo, onEdit, onFavorite, onDelete, selected, onSelect, readOnly = false, draggable = false, dragging = false, dropTarget = false, onDragStart, onDragOver, onDrop, onDragEnd }: {
  phrase: Phrase; category?: Category; compact?: boolean; index: number; onCopy: (item: Phrase) => void; onPreviewVideo: (video: VideoAttachment) => void
  onEdit: () => void; onFavorite: (id: string) => void; onDelete: (id: string) => void
  selected: boolean; onSelect: () => void; readOnly?: boolean
  draggable?: boolean; dragging?: boolean; dropTarget?: boolean
  onDragStart?: (event: ReactDragEvent<HTMLElement>) => void; onDragOver?: (event: ReactDragEvent<HTMLElement>) => void
  onDrop?: (event: ReactDragEvent<HTMLElement>) => void; onDragEnd?: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const images = phraseImages(phrase)
  const videos = phraseVideos(phrase)
  const videoOnly = !phrase.text.trim() && images.length === 0 && videos.length > 0
  return <article className={`phrase-card${compact ? ' compact-card' : ''}${selected ? ' is-selected' : ''}${draggable ? ' is-draggable' : ''}${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`} style={{ animationDelay: `${Math.min(index, 7) * 35}ms` }} draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}>
    <div className="card-topline"><span className="card-category"><span className="category-color" style={{ backgroundColor: category?.color ?? '#8b9ba8' }} />{category?.name ?? '未分类'}</span><div className="card-top-actions">
      {!compact && !readOnly && <><button className={`card-star${phrase.favorite ? ' starred' : ''}`} onClick={() => onFavorite(phrase.id)} aria-label="收藏"><Star size={15} fill={phrase.favorite ? 'currentColor' : 'none'} /></button>
      <div className="card-menu-wrap"><button className="card-more" onClick={() => setMenuOpen(!menuOpen)} aria-label="更多操作"><MoreHorizontal size={17} /></button>{menuOpen && <><button className="menu-dismiss" onClick={() => setMenuOpen(false)} aria-label="关闭菜单" /><div className="card-menu"><button onClick={() => { setMenuOpen(false); onEdit() }}><Pencil size={14} />编辑话术</button><button className="danger-action" onClick={() => { setMenuOpen(false); onDelete(phrase.id) }}><Trash2 size={14} />删除话术</button></div></>}</div></>}
    </div></div>
    <button className="card-select" aria-label={selected ? '取消选择' : '选择话术'} onClick={onSelect}><span className="checkbox-ui">{selected && <Check size={11} />}</span></button>
    <div className="card-content"><h3>{phrase.title || '未命名话术'}</h3><p>{phrase.text || (images.length ? `${images.length > 1 ? `${images.length} 张图片` : '图片内容'} · 点击复制后粘贴` : videos.length ? `${videos.length} 个视频附件 · 点击名称预览` : '暂无内容')}</p>{images.length > 0 && <div className="card-images">{images.map((image, imageIndex) => <img className="card-image" key={`${phrase.id}-image-${imageIndex}`} src={image} alt={`话术配图 ${imageIndex + 1}`} />)}</div>}{videos.length > 0 && <div className="card-videos">{videos.map((video) => <button type="button" className="card-video-button" key={video.id} onClick={() => onPreviewVideo(video)} title={`预览 ${video.name}`}><Play size={12} fill="currentColor" /><span>{video.name}</span><small>{formatFileSize(video.size)}</small></button>)}</div>}</div>
    {phrase.tags.length > 0 && <div className="card-tags">{phrase.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>}
    <div className="card-bottom"><span className="shortcut-label">{phrase.shortcut ? <><kbd>{(phrase.shortcutModifier ?? 'alt') === 'ctrl' ? 'Ctrl' : 'Alt'}</kbd> + {phrase.shortcut}</> : <><span className="shortcut-dot" />可快速回复</>}</span><button className="copy-button" onClick={() => onCopy(phrase)}><Copy size={13} /><span>{videoOnly ? '复制视频' : compact ? '复制' : '复制话术'}</span></button></div>
  </article>
}

function EmptyState({ searching, onAdd, canAdd = true }: { searching: boolean; onAdd: () => void; canAdd?: boolean }) {
  return <div className="empty-state"><div className="empty-illustration"><MessageCircle size={26} /><span><Sparkles size={13} /></span></div><h3>{searching ? '没有找到匹配的话术' : '这个分类还没有话术'}</h3><p>{searching ? '试试换关键词、拼音首字母，或清空搜索。' : canAdd ? '把常用回答收进来，下次就不用重复输入了。' : '此设备为只读模式，请在主电脑新增话术。'}</p>{!searching && canAdd && <button className="button-primary" onClick={onAdd}><Plus size={15} />新建第一条话术</button>}</div>
}

function Toast({ message }: { message: string }) {
  return <div className="toast"><span><Check size={14} /></span>{message}</div>
}

function downloadFile(content: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url)
}

async function deliverFile(content: BlobPart, filename: string, mime: string) {
  if (window.kefuAndroid) await saveAndroidExport(content, filename, mime)
  else downloadFile(content, filename, mime)
}

function readImageFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

function PhraseEditor({ categories, initial, workspace, cloudSync, onClose, onSave, onPreviewVideo }: { categories: Category[]; initial: Phrase | null; workspace: Workspace; cloudSync: boolean; onClose: () => void; onSave: (phrase: Phrase) => void; onPreviewVideo: (video: VideoAttachment) => void }) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [text, setText] = useState(initial?.text ?? '')
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? categories[0]?.id ?? '')
  const [tags, setTags] = useState(initial?.tags.join('，') ?? '')
  const [shortcut, setShortcut] = useState(initial?.shortcut ?? '')
  const [shortcutModifier, setShortcutModifier] = useState<ShortcutModifier>(initial?.shortcutModifier ?? 'alt')
  const [images, setImages] = useState(() => initial ? phraseImages(initial) : [])
  const [videos, setVideos] = useState(() => initial ? phraseVideos(initial) : [])
  const [pendingVideos, setPendingVideos] = useState<File[]>([])
  const [videoBusy, setVideoBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const videoFileRef = useRef<HTMLInputElement>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim() && images.length === 0 && videos.length === 0 && pendingVideos.length === 0) return setError('请填写话术内容或添加至少一个附件')
    if (!categoryId) return setError('请先创建一个话术分类')
    setVideoBusy(true); setError('')
    try {
      const savedVideos = [...videos]
      for (const file of pendingVideos) {
        if (!window.kefuDesk) throw new Error('视频附件仅支持桌面版')
        const id = crypto.randomUUID()
        const saved = await window.kefuDesk.writeVideo({ id, name: file.name, mime: file.type, data: await file.arrayBuffer() }, workspace)
        savedVideos.push(saved)
      }
      onSave({ id: initial?.id ?? uid(), title: title.trim() || text.trim().slice(0, 18) || (images.length ? '图片话术' : '视频话术'), text: text.trim(), categoryId, tags: tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean), images: images.length ? images : undefined, videos: savedVideos.length ? savedVideos : undefined, shortcut: shortcut.trim(), shortcutModifier, favorite: initial?.favorite, updatedAt: Date.now() })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '视频保存失败，请重试')
    } finally { setVideoBusy(false) }
  }
  const loadImages = async (files: File[]) => {
    if (!files.length) return
    if (files.some((file) => !file.type.startsWith('image/'))) return setError('目前仅支持添加图片')
    if (files.some((file) => file.size > 5 * 1024 * 1024)) return setError('单张图片不能超过 5 MB')
    try {
      const loadedImages = await Promise.all(files.map(readImageFile))
      setImages((current) => [...current, ...loadedImages])
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '图片读取失败')
    }
  }
  const loadVideos = (files: File[]) => {
    if (!files.length) return
    if (files.some((file) => !file.type.startsWith('video/'))) return setError('请选择有效的视频文件')
    if (files.some((file) => file.size === 0 || file.size > MAX_VIDEO_BYTES)) return setError('视频不能为空，且单个文件不能超过 50 MB')
    setPendingVideos((current) => [...current, ...files]); setError('')
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !videoBusy) onClose() }}><form className="editor-modal" onSubmit={(event) => void submit(event)}>
    <div className="modal-heading"><div><div className="modal-eyebrow">{initial ? 'EDIT REPLY' : 'NEW REPLY'}</div><h2>{initial ? '编辑话术' : '新建话术'}</h2><p>写下这句回答，下次一键就能用。</p></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <label className="field-label">话术名称 <span>用于快速识别</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={40} placeholder="例如：欢迎光临" autoFocus /></label>
    <label className="field-label">回复内容 <span>{text.length} / 2000</span><textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} rows={5} placeholder="输入要发送给客户的内容…" /></label>
    <div className="field-grid"><label className="field-label">所属分类<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>{categories.map((item) => <option value={item.id} key={item.id}>{item.name} · {scopeNames[item.scope]}</option>)}</select></label><label className="field-label">快捷键 <span>可选</span><div className="shortcut-input"><select aria-label="快捷键前缀" value={shortcutModifier} onChange={(event) => setShortcutModifier(event.target.value as ShortcutModifier)}><option value="alt">Alt</option><option value="ctrl">Ctrl</option></select><span>+</span><input aria-label="快捷键数字" value={shortcut} onChange={(event) => setShortcut(event.target.value.replace(/[^1-9]/g, '').slice(0, 1))} placeholder="1–9" maxLength={1} /></div></label></div>
    <label className="field-label">标签 <span>用逗号分隔</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：欢迎，接待" /></label>
    <div className="attachment-row"><div><strong><ImagePlus size={15} />图片附件{images.length > 0 && <em>{images.length} 张</em>}</strong><span>可添加多张图片，数量不限；单张不超过 5 MB</span></div><button type="button" className="button-quiet" onClick={() => fileRef.current?.click()}>{images.length ? '继续添加' : '添加图片'}</button><input ref={fileRef} type="file" accept="image/*" multiple className="hidden-input" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void loadImages(files) }} /></div>
    {images.length > 0 && <div className="image-preview-grid">{images.map((image, imageIndex) => <div className="image-preview" key={`preview-${imageIndex}`}><img src={image} alt={`附件预览 ${imageIndex + 1}`} /><button type="button" className="icon-button" onClick={() => setImages((current) => current.filter((_, index) => index !== imageIndex))} aria-label={`删除第 ${imageIndex + 1} 张图片`}><X size={15} /></button></div>)}</div>}
    <div className="attachment-row video-attachment-row"><div><strong><Film size={15} />视频附件{videos.length + pendingVideos.length > 0 && <em>{videos.length + pendingVideos.length} 个</em>}</strong><span>{window.kefuAndroid ? '安卓端可保留同步记录，但暂不支持添加或播放' : '每个视频不超过 50 MB；视频文件单独保存，不增大话术 JSON'}</span></div><button type="button" className="button-quiet" onClick={() => videoFileRef.current?.click()} disabled={!window.kefuDesk || Boolean(window.kefuAndroid) || videoBusy}>{videos.length + pendingVideos.length ? '继续添加' : '添加视频'}</button><input ref={videoFileRef} type="file" accept="video/*" multiple className="hidden-input" disabled={!window.kefuDesk || Boolean(window.kefuAndroid)} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; loadVideos(files) }} /></div>
    {(videos.length > 0 || pendingVideos.length > 0) && <div className="video-attachment-list">{videos.map((video) => <div className="video-attachment-item" key={video.id}><button type="button" className="video-attachment-preview" onClick={() => onPreviewVideo(video)}><Play size={13} fill="currentColor" /><span>{video.name}</span><small>{formatFileSize(video.size)}</small></button><button type="button" className="icon-button" onClick={() => setVideos((current) => current.filter((item) => item.id !== video.id))} aria-label={`移除 ${video.name}`}><X size={15} /></button></div>)}{pendingVideos.map((video, index) => <div className="video-attachment-item" key={`${video.name}-${video.lastModified}-${index}`}><span className="video-attachment-preview"><Film size={13} /><span>{video.name}</span><small>{formatFileSize(video.size)}</small></span><button type="button" className="icon-button" onClick={() => setPendingVideos((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除 ${video.name}`}><X size={15} /></button></div>)}</div>}
    {!window.kefuDesk && <div className="video-support-note">视频附件仅在客服宝桌面安装版中可用。</div>}
    {error && <div className="form-error">{error}</div>}
    <div className="modal-footer"><span><ShieldCheck size={13} />{cloudSync ? '本机保存，坚果云自动同步' : '仅保存在此设备'}</span><div><button type="button" className="button-quiet" onClick={onClose} disabled={videoBusy}>取消</button><button type="submit" className="button-primary" disabled={videoBusy}>{videoBusy ? '保存中…' : <><Check size={15} />保存话术</>}</button></div></div>
  </form></div>
}

function CategoryEditor({ initial, onClose, onSave, onDelete }: { initial: Category | null; onClose: () => void; onSave: (item: Category) => void; onDelete: (item: Category) => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [scope, setScope] = useState<Scope>(initial?.scope ?? 'company')
  const [color, setColor] = useState(initial?.color ?? colors[0])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="category-modal" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSave({ id: initial?.id ?? uid(), name: name.trim(), scope, color }) }}>
    <div className="modal-heading"><div><div className="modal-eyebrow">ORGANIZE REPLIES</div><h2>{initial ? '编辑分类' : '新建分类'}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <label className="field-label">分类名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} placeholder="例如：物流查询" autoFocus /></label>
    <label className="field-label">可见范围<select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="company">公司共享（本机标记）</option><option value="group">小组共享（本机标记）</option><option value="private">私人话术</option></select></label>
    <div className="field-label">分类颜色<div className="color-options">{colors.map((item) => <button type="button" key={item} className={color === item ? 'color-selected' : ''} style={{ backgroundColor: item }} onClick={() => setColor(item)} aria-label={`选择颜色 ${item}`}>{color === item && <Check size={13} />}</button>)}</div></div>
    <div className="modal-footer">{initial ? <button type="button" className="delete-category" onClick={() => onDelete(initial)}><Trash2 size={14} />删除分类</button> : <span /> }<div><button type="button" className="button-quiet" onClick={onClose}>取消</button><button type="submit" className="button-primary"><Check size={15} />保存分类</button></div></div>
  </form></div>
}
