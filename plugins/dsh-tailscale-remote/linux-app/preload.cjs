const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('dsh', { connect: url => ipcRenderer.invoke('connect', url) })
