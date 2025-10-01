const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Q CLI Operations
  createSession: () => ipcRenderer.invoke('create-session'),
  sendToQ: (sessionId, input) => ipcRenderer.invoke('send-to-q', { sessionId, input }),
  killSession: (sessionId) => ipcRenderer.invoke('kill-session', sessionId),
  checkDocker: () => ipcRenderer.invoke('check-docker'),
  
  // Chat Management
  saveChat: (chatData) => ipcRenderer.invoke('save-chat', chatData),
  getChatList: () => ipcRenderer.invoke('get-chat-list'),
  loadChat: (chatId) => ipcRenderer.invoke('load-chat', chatId),
  updateChat: (chatData) => ipcRenderer.invoke('update-chat', chatData),
  deleteChat: (chatId) => ipcRenderer.invoke('delete-chat', chatId),
  
  // Event listeners
  onQOutput: (callback) => ipcRenderer.on('q-output', callback),
  onSessionClosed: (callback) => ipcRenderer.on('session-closed', callback),
  onDockerWarning: (callback) => ipcRenderer.on('docker-warning', callback),
  
  // MCP Config
  getMcpConfig: () => ipcRenderer.invoke('get-mcp-config'),
  saveMcpConfig: (content) => ipcRenderer.invoke('save-mcp-config', content),
  
  // File Operations
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  openFileExternal: (filePath) => ipcRenderer.invoke('open-file-external', filePath),
  
  // Report Export
  saveReport: (filename, htmlContent) => ipcRenderer.invoke('save-report', filename, htmlContent),
  
  // App Control
  closeApp: () => ipcRenderer.invoke('close-app'),
  
  // Cleanup
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('q-output');
    ipcRenderer.removeAllListeners('session-closed');
  }
});
