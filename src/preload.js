const { contextBridge, ipcRenderer } = require('electron');

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('api', {
  // Function to download video
  downloadVideo: (url, options) => {
    return ipcRenderer.invoke('download-video', url, options);
  },
  
  // Function to force download (overwrite)
  forceDownload: () => {
    return ipcRenderer.invoke('force-download');
  },
  
  // Function to stop download
  stopDownload: () => {
    return ipcRenderer.send('stop-download');
  },
  
  // Function to open folder in file explorer
  openFolder: (folderPath) => {
    return ipcRenderer.invoke('open-folder', folderPath);
  },
  
  // Listen for download progress updates
  onProgress: (callback) => {
    ipcRenderer.on('download-progress', (event, data) => {
      callback(data);
    });
  },
  
  // Get asset path
  getAssetPath: (assetName) => {
    return ipcRenderer.invoke('get-asset-path', assetName);
  },

  // Function to retry download with highest quality
  retryWithHighestQuality: () => {
    return ipcRenderer.invoke('retry-highest-quality');
  }
});