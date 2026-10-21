import type { PluginListenerHandle } from '@capacitor/core'

export {}

declare global {
  interface Window {
    kefuAndroid?: {
      readLibrary: (options: { workspace: 'local' | 'cloud' }) => Promise<{ value: string | null }>
      writeLibrary: (options: { workspace: 'local' | 'cloud'; value: string }) => Promise<{ success: boolean }>
      writeCloudLibraryCache: (options: { value: string }) => Promise<{ success: boolean }>
      getWorkspace: () => Promise<{ workspace: 'local' | 'cloud' }>
      setWorkspace: (options: { workspace: 'local' | 'cloud' }) => Promise<{ workspace: 'local' | 'cloud' }>
      getPetStatus: () => Promise<{ permissionGranted: boolean; running: boolean }>
      requestOverlayPermission: () => Promise<{ permissionGranted: boolean }>
      startPet: () => Promise<void>
      stopPet: () => Promise<void>
      closePetPanel: () => Promise<void>
      readAppFile: (options: { name: string }) => Promise<{ value: string | null }>
      writeAppFile: (options: { name: string; value: string }) => Promise<void>
      deleteAppFile: (options: { name: string }) => Promise<void>
      copyContent: (options: { text: string; images: string[] }) => Promise<{ success: boolean }>
      setSecret: (options: { value: string }) => Promise<void>
      getSecret: () => Promise<{ value: string | null }>
      removeSecret: () => Promise<void>
      addListener: (eventName: string, listener: (value: { success?: boolean; value?: string | null; workspace?: 'local' | 'cloud'; permissionGranted?: boolean; running?: boolean }) => void) => Promise<PluginListenerHandle>
    }
    kefuDesk?: {
      readLibrary: (workspace: 'local' | 'cloud') => Promise<string | null>
      writeLibrary: (value: string, workspace: 'local' | 'cloud') => Promise<boolean>
      getWorkspace: () => Promise<'local' | 'cloud'>
      setWorkspace: (workspace: 'local' | 'cloud') => Promise<'local' | 'cloud'>
      getAutoLaunch: () => Promise<{ supported: boolean; enabled: boolean }>
      setAutoLaunch: (value: boolean) => Promise<{ supported: boolean; enabled: boolean }>
      writeVideo: (value: { id: string; name: string; mime: string; data: ArrayBuffer; sha256?: string }, workspace: 'local' | 'cloud') => Promise<{ id: string; name: string; mime: string; size: number; sha256: string }>
      readVideo: (id: string, name: string, expectedSize: number, sha256: string, workspace: 'local' | 'cloud') => Promise<Uint8Array | null>
      revealVideo: (id: string, name: string, expectedSize: number, sha256: string, workspace: 'local' | 'cloud') => Promise<boolean>
      copyText: (value: string) => Promise<boolean>
      copyImage: (value: string) => Promise<boolean>
      copyRich: (value: { text: string; html: string; image?: string; images?: string[]; videos?: { id: string; name: string; mime: string; size: number; sha256: string }[]; workspace: 'local' | 'cloud' }) => Promise<boolean>
      hideOverlay: () => Promise<boolean>
      resizeOverlay: (direction: -1 | 1) => Promise<number>
      getOverlayPinned: () => Promise<boolean>
      setOverlayPinned: (value: boolean) => Promise<boolean>
      getOverlaySort: () => Promise<{ mode: 'recent' | 'manual'; order: string[] }>
      setOverlaySort: (value: { mode: 'recent' | 'manual'; order: string[] }) => Promise<{ mode: 'recent' | 'manual'; order: string[] }>
      onOverlaySortUpdated: (callback: (value: { mode: 'recent' | 'manual'; order: string[] }) => void) => () => void
      getSyncConfig: () => Promise<{ configured: boolean; url: string; username: string; deviceRole: 'primary' | 'readonly' }>
      getSyncStatus: () => Promise<{ configured: boolean; syncing: boolean; lastSyncAt: number | null; conflictCount?: number; error: string; message?: string; deviceRole: 'local' | 'primary' | 'readonly'; canEdit: boolean }>
      configureSync: (value: { url: string; username: string; password: string; deviceRole: 'primary' | 'readonly' }) => Promise<{ configured: boolean; syncing: boolean; lastSyncAt: number | null; conflictCount?: number; error: string; message?: string; deviceRole: 'local' | 'primary' | 'readonly'; canEdit: boolean }>
      runSync: () => Promise<{ configured: boolean; syncing: boolean; lastSyncAt: number | null; conflictCount?: number; error: string; message?: string; deviceRole: 'local' | 'primary' | 'readonly'; canEdit: boolean }>
      disconnectSync: () => Promise<{ configured: boolean; syncing: boolean; lastSyncAt: number | null; error: string; message?: string; deviceRole: 'local' | 'primary' | 'readonly'; canEdit: boolean }>
      onOverlayFocus: (callback: () => void) => () => void
      onLibraryUpdated: (callback: (value: { workspace: 'local' | 'cloud'; value: string }) => void) => () => void
      onWorkspaceUpdated: (callback: (workspace: 'local' | 'cloud') => void) => () => void
      onSyncStatus: (callback: (value: { configured: boolean; syncing: boolean; lastSyncAt: number | null; conflictCount?: number; error: string; message?: string; deviceRole: 'local' | 'primary' | 'readonly'; canEdit: boolean }) => void) => () => void
    }
  }
}
