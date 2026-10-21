const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kefuDesk', {
  readLibrary: (workspace) => ipcRenderer.invoke('library:read', workspace),
  writeLibrary: (value, workspace) => ipcRenderer.invoke('library:write', value, workspace),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  setWorkspace: (workspace) => ipcRenderer.invoke('workspace:set', workspace),
  getAutoLaunch: () => ipcRenderer.invoke('app:get-auto-launch'),
  setAutoLaunch: (value) => ipcRenderer.invoke('app:set-auto-launch', value),
  writeVideo: (value, workspace) => ipcRenderer.invoke('video:write', value, workspace),
  readVideo: (id, name, expectedSize, sha256, workspace) => ipcRenderer.invoke('video:read', id, name, expectedSize, sha256, workspace),
  revealVideo: (id, name, expectedSize, sha256, workspace) => ipcRenderer.invoke('video:reveal', id, name, expectedSize, sha256, workspace),
  copyText: (value) => ipcRenderer.invoke('clipboard:write-text', value),
  copyImage: (value) => ipcRenderer.invoke('clipboard:write-image', value),
  copyRich: (value) => ipcRenderer.invoke('clipboard:write-rich', value),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  resizeOverlay: (direction) => ipcRenderer.invoke('overlay:resize', direction),
  getOverlayPinned: () => ipcRenderer.invoke('overlay:get-pinned'),
  setOverlayPinned: (value) => ipcRenderer.invoke('overlay:set-pinned', value),
  getOverlaySort: () => ipcRenderer.invoke('overlay:get-sort'),
  setOverlaySort: (value) => ipcRenderer.invoke('overlay:set-sort', value),
  onOverlaySortUpdated: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('overlay:sort-updated', listener)
    return () => ipcRenderer.removeListener('overlay:sort-updated', listener)
  },
  getSyncConfig: () => ipcRenderer.invoke('sync:get-config'),
  getSyncStatus: () => ipcRenderer.invoke('sync:get-status'),
  configureSync: (value) => ipcRenderer.invoke('sync:configure', value),
  runSync: () => ipcRenderer.invoke('sync:run'),
  disconnectSync: () => ipcRenderer.invoke('sync:disconnect'),
  onOverlayFocus: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('overlay-focus', listener)
    return () => ipcRenderer.removeListener('overlay-focus', listener)
  },
  onLibraryUpdated: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('library:updated', listener)
    return () => ipcRenderer.removeListener('library:updated', listener)
  },
  onWorkspaceUpdated: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('workspace:updated', listener)
    return () => ipcRenderer.removeListener('workspace:updated', listener)
  },
  onSyncStatus: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('sync:status', listener)
    return () => ipcRenderer.removeListener('sync:status', listener)
  },
})
