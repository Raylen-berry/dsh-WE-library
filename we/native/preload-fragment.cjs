// Appended by tools/install-native-bridge.mjs to DSH's trusted preload.
electron.contextBridge.exposeInMainWorld('dshWallpaper', Object.freeze({
  capability: () => electron.ipcRenderer.invoke('dwl-live:capability'),
  start: (id, token) => electron.ipcRenderer.invoke('dwl-live:start', {id, token}),
  stop: token => electron.ipcRenderer.invoke('dwl-live:stop', token),
  properties: (id, action = 'read', values, name) => electron.ipcRenderer.invoke('dwl-live:properties', {id, action, values, name}),
  onVisibility: callback => {
    const listener = (_event, visible) => callback(visible === true);
    electron.ipcRenderer.on('dwl-live:visibility', listener);
    return () => electron.ipcRenderer.removeListener('dwl-live:visibility', listener);
  },
}));
