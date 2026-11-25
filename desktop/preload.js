'use strict';

/**
 * 桌面端预加载脚本（contextIsolation + sandbox 下运行）
 * 只暴露最小、只读或明确语义的桥接方法，页面本身仍是纯 Web 代码。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gmmDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('gmm:info'),
  openDataDir: () => ipcRenderer.invoke('gmm:open-data'),
  openLog: () => ipcRenderer.invoke('gmm:open-log'),
  restartServer: () => ipcRenderer.invoke('gmm:restart-server'),
  showWindow: () => ipcRenderer.invoke('gmm:show-window')
});
