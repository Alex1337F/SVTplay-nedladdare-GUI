const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let currentProcess = null;
let lastUrl = '';
let lastOptions = {};

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 750,
    resizable: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
  });

  // Remove the menu bar
  Menu.setApplicationMenu(null);

  // Add this handler in your createWindow function, before loading the HTML file
  ipcMain.handle('get-asset-path', (event, assetName) => {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'assets', assetName);
    } else {
      return path.join(__dirname, 'assets', assetName);
    }
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Handle the download video request
  ipcMain.handle('download-video', async (event, url, options) => {
    // Store the URL and options for potential reuse
    lastUrl = url;
    lastOptions = { ...options };
    
    return startDownload(mainWindow, url, options);
  });
  
  // Handle force download request (after user confirmation)
  ipcMain.handle('force-download', async () => {
    return startDownload(mainWindow, lastUrl, { ...lastOptions, force: true });
  });
  
  // Handle stop download request
  ipcMain.on('stop-download', () => {
    if (currentProcess) {
      // Kill the process on Windows
      try {
        currentProcess.kill('SIGTERM');
        mainWindow.webContents.send('download-progress', { 
          type: 'stopped'
        });
      } catch (error) {
        mainWindow.webContents.send('download-progress', { 
          type: 'error', 
          data: `Failed to stop process: ${error.message}` 
        });
      }
      currentProcess = null;
    }
  });

  // Handle opening folders
  ipcMain.handle('open-folder', async (event, folderPath) => {
    try {
      await shell.openPath(folderPath);
      return { success: true };
    } catch (error) {
      console.error('Failed to open folder:', error);
      return { success: false, error: error.message };
    }
  });

  // Handle retry with highest quality
  ipcMain.handle('retry-highest-quality', async () => {
    // Create a new options object with default quality
    const newOptions = { ...lastOptions, quality: 'default' };
    return startDownload(mainWindow, lastUrl, newOptions);
  });
};

// Function to get the path to the svtplay-dl executable
function getSvtPlayDlPath() {
  // For development
  let exePath = path.join(__dirname, 'svtplay-dl', 'svtplay-dl.exe');
  
  // For production (when packaged in ASAR)
  if (app.isPackaged) {
    exePath = path.join(process.resourcesPath, 'svtplay-dl', 'svtplay-dl.exe');
  }
  
  return exePath;
}

// Function to start the download process
function startDownload(mainWindow, url, options) {
  return new Promise((resolve, reject) => {
    try {
      // Get the user's Videos directory
      const videosDir = path.join(os.homedir(), 'Videos', 'SVTPlayDownloader');
      
      // Create the directory if it doesn't exist
      if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true });
      }
      
      // Build the arguments array based on options
      const args = [];
      args.push('--format-preferred');
      args.push('hevc-51,hevc,h264,h264-51');
      
      // Add resolution flag if specified (not default)
      if (options.quality && options.quality !== 'default') {
        args.push('--resolution');
        args.push(options.quality);
      }
      
      // Add subtitle flag if requested
      if (options.subtitles) {
        args.push('-S');
        args.push('-M');
      }
      
      // Add whole series flag if requested
      if (options.wholeSeries) {
        args.push('-A');
        args.push('--subfolder');
      }

      // Add force flag if requested
      if (options.force) {
        args.push('--force');
      }
      
      // Add the URL
      args.push(url);
      
      // Path to the svtplay-dl executable
      const svtplayDlPath = getSvtPlayDlPath();
      
      // Execute the command with the videos directory as the working directory
      const process = spawn(svtplayDlPath, args, { cwd: videosDir });
      
      // Store the current process to be able to kill it later
      currentProcess = process;
      
      let output = '';
      let fileExistsDetected = false;
      
      // Listen for data from stdout
      process.stdout.on('data', (data) => {
        const newData = data.toString();
        output += newData;
        
        // Check if warning about existing file appears
        if ((newData.includes('WARNING') || output.includes('WARNING')) && 
            ((newData.includes('already exists') && newData.includes('Use --force to overwrite')) || 
             (output.includes('already exists') && output.includes('Use --force to overwrite'))) && 
            !fileExistsDetected) {
          fileExistsDetected = true;
          
          // Send event to renderer to show confirmation dialog
          mainWindow.webContents.send('download-progress', { 
            type: 'file-exists'
          });
          
          // Kill the current process as we need user confirmation
          if (currentProcess) {
            currentProcess.kill('SIGTERM');
            currentProcess = null;
          }
        } 
        // Check for resolution error
        else if ((newData.includes('ERROR') || output.includes('ERROR')) && 
                 ((newData.includes("Can't find any streams with that video resolution")) || 
                  (output.includes("Can't find any streams with that video resolution"))) &&
                 options.quality !== 'default') {
          
          // Send event to renderer to show resolution error dialog
          mainWindow.webContents.send('download-progress', { 
            type: 'resolution-error'
          });
          
          // Kill the current process as we need user input
          if (currentProcess) {
            currentProcess.kill('SIGTERM');
            currentProcess = null;
          }
        } else {
          mainWindow.webContents.send('download-progress', { type: 'output', data: newData });
        }
      });
      
      // Listen for data from stderr
      process.stderr.on('data', (data) => {
        const newData = data.toString();
        output += newData;
        mainWindow.webContents.send('download-progress', { type: 'error', data: newData });
      });
      
      // Handle process completion
      process.on('close', (code) => {
        // Check for resolution error in the complete output
        if (!fileExistsDetected && 
            output.includes("Can't find any streams with that video resolution") && 
            options.quality !== 'default') {
          
          // Send event to renderer to show resolution error dialog
          mainWindow.webContents.send('download-progress', { 
            type: 'resolution-error'
          });
          
          return;
        }
        
        // Check again for file exists warning in the complete output
        if (!fileExistsDetected && 
            output.includes('already exists') && 
            output.includes('Use --force to overwrite')) {
          fileExistsDetected = true;
          
          // Send event to renderer to show confirmation dialog
          mainWindow.webContents.send('download-progress', { 
            type: 'file-exists'
          });
          
          return;
        }
        
        // Only proceed if we haven't already detected special conditions
        if (!fileExistsDetected) {
          currentProcess = null;
          
          if (code === 0) {
            resolve({ success: true, output });
            mainWindow.webContents.send('download-progress', { 
              type: 'complete', 
              success: true,
              savePath: videosDir
            });
          } else {
            resolve({ success: false, output, code });
            mainWindow.webContents.send('download-progress', { 
              type: 'complete', 
              success: false,
              code
            });
          }
        }
      });
      
      // Handle process errors
      process.on('error', (err) => {
        if (!fileExistsDetected) {
          currentProcess = null;
          resolve({ success: false, error: err.message });
          mainWindow.webContents.send('download-progress', { 
            type: 'error', 
            data: err.message 
          });
        }
      });
    } catch (error) {
      currentProcess = null;
      resolve({ success: false, error: error.message });
      mainWindow.webContents.send('download-progress', { 
        type: 'error', 
        data: error.message 
      });
    }
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});