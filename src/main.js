const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Database setup
let sqlite3;
let db;
try {
  sqlite3 = require('sqlite3').verbose();
  const dbPath = path.join(app.getPath('userData'), 'chats.db');
  db = new sqlite3.Database(dbPath);
  
  // Create table if not exists
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS saved_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
  
  console.log('Database initialized at:', dbPath);
} catch (error) {
  console.error('Failed to initialize database:', error);
  db = null;
}

// Try to load node-pty, fallback to child_process if it fails
let pty;
let useNodePty = true;
try {
  pty = require('node-pty');
  console.log('node-pty loaded successfully');
} catch (error) {
  console.log('node-pty failed to load, using child_process fallback:', error.message);
  const { spawn } = require('child_process');
  useNodePty = false;
}

let mainWindow;
const sessions = new Map();

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  // Ensure app is ready before creating window
  if (!app.isReady()) {
    console.log('App not ready, waiting...');
    app.whenReady().then(createWindow);
    return;
  }
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Classic Q Interface',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      devTools: process.env.NODE_ENV === 'development' // Only in development
    }
  });

  // Open DevTools only in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Handle window close event
  mainWindow.on('close', (event) => {
    console.log('Window closing, cleaning up sessions...');
    
    // Kill all Q processes before closing
    sessions.forEach(session => {
      if (session.process) {
        try {
          session.process.kill('SIGTERM');
          console.log('Killed session process');
        } catch (error) {
          console.error('Error killing session:', error);
        }
      }
    });
    sessions.clear();
    
    // Set mainWindow to null to prevent further IPC calls
    mainWindow = null;
  });

  mainWindow.loadFile('index.html');
  
  // Set app icon for macOS dock
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  }
  
  // Create custom menu
  createMenu();
}

function createMenu() {
  const template = [
    {
      label: 'Classic Q Interface',
      submenu: [
        {
          label: 'About Classic Q Interface',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Classic Q Interface',
              message: 'Classic Q Interface',
              detail: 'Version: v0.0.1-alpha\n\nA 90s-style web interface for Amazon Q CLI with export features, and classic aesthetics.\n\nBuilt with Electron.',
              icon: path.join(__dirname, '..', 'assets', 'icon.png'),
              buttons: ['OK']
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    }
  ];

  // Add standard Edit menu for macOS
  if (process.platform === 'darwin') {
    template.push({
      label: 'Edit',
      submenu: [
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', selector: 'cut:' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', selector: 'copy:' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', selector: 'paste:' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Docker status check
function checkDockerStatus() {
  const { execSync } = require('child_process');
  
  try {
    // Try multiple Docker paths
    const dockerPaths = [
      'docker',
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
      '/Applications/Docker.app/Contents/Resources/bin/docker'
    ];
    
    for (const dockerPath of dockerPaths) {
      try {
        execSync(`${dockerPath} ps`, { stdio: 'pipe', timeout: 3000 });
        console.log('Docker check: running via', dockerPath);
        return { running: true, error: null };
      } catch (e) {
        continue;
      }
    }
    
    console.log('Docker check: not found in any path');
    return { running: false, error: 'Docker not found' };
  } catch (error) {
    console.log('Docker check failed:', error.message);
    return { running: false, error: 'Docker not running' };
  }
}

// Cross-platform Q CLI path detection
function findQCliPath() {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  
  // Try 'which' command first (works on macOS/Linux)
  try {
    const result = execSync('which q', { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) {
      console.log('Found Q CLI via which:', result);
      return result;
    }
  } catch (e) {
    // Continue to manual search
  }
  
  // Try 'where' command on Windows
  if (process.platform === 'win32') {
    try {
      const result = execSync('where q', { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')[0];
      if (result && fs.existsSync(result)) {
        console.log('Found Q CLI via where:', result);
        return result;
      }
    } catch (e) {
      // Continue to manual search
    }
  }
  
  // Manual path search - platform specific
  let searchPaths = [];
  
  if (process.platform === 'darwin' || process.platform === 'linux') {
    // macOS and Linux paths
    searchPaths = [
      '/usr/local/bin/q',
      '/opt/homebrew/bin/q',
      os.homedir() + '/bin/q',
      os.homedir() + '/.local/bin/q',
      '/usr/bin/q'
    ];
  } else if (process.platform === 'win32') {
    // Windows paths
    searchPaths = [
      'q.exe', // Try PATH first
      process.env.PROGRAMFILES + '\\Amazon\\AWSCLIV2\\q.exe',
      process.env.USERPROFILE + '\\AppData\\Local\\Programs\\q\\q.exe',
      process.env.PROGRAMFILES + '\\q\\q.exe',
      'C:\\Program Files\\Amazon\\AWSCLIV2\\q.exe'
    ];
  }
  
  // Check each path
  for (const testPath of searchPaths) {
    try {
      if (fs.existsSync(testPath)) {
        console.log('Found Q CLI at:', testPath);
        return testPath;
      }
    } catch (e) {
      // Continue searching
    }
  }
  
  console.log('Q CLI not found in common locations, using default "q"');
  return 'q'; // Fallback to PATH
}

// Docker status check endpoint
ipcMain.handle('check-docker', async () => {
  return checkDockerStatus();
});

// Q CLI Session Management with cross-platform path detection
ipcMain.handle('create-session', async () => {
  const sessionId = Date.now().toString();
  
  try {
    let qProcess;
    const qCliPath = findQCliPath(); // Get platform-specific Q CLI path
    const os = require('os');
    const userHome = os.homedir(); // Get user home directory for proper context
    
    // Build comprehensive PATH for MCP servers (including Docker)
    const originalPath = process.env.PATH || '';
    const additionalPaths = [
      '/usr/local/bin',           // Homebrew Intel, Docker Desktop
      '/opt/homebrew/bin',        // Homebrew Apple Silicon
      '/Applications/Docker.app/Contents/Resources/bin', // Docker Desktop
      '/usr/bin',                 // System binaries
      userHome + '/bin',          // User binaries
      userHome + '/.local/bin',   // Local installs
      userHome + '/.npm-global/bin', // Global npm packages
      '/usr/local/lib/node_modules/.bin', // Node.js modules
      '/opt/homebrew/lib/node_modules/.bin' // Homebrew Node.js modules
    ];
    
    const comprehensivePath = [originalPath, ...additionalPaths].join(':');
    
    if (useNodePty && pty) {
      console.log('Using node-pty for session creation with path:', qCliPath);
      console.log('Working directory:', userHome);
      console.log('Comprehensive PATH:', comprehensivePath);
      // Use node-pty for proper terminal emulation
      qProcess = pty.spawn(qCliPath, ['chat'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: userHome,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          HOME: userHome,
          USERPROFILE: userHome,
          PATH: comprehensivePath
        }
      });
      
      sessions.set(sessionId, { process: qProcess, state: 'ready', type: 'pty' });
      
      // Handle data from Q CLI - send raw terminal data
      qProcess.onData((data) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          console.log('Window closed, ignoring Q CLI output');
          return;
        }
        
        const isPrompt = /\(y\/n\)|Do you want to continue\?|Can I|Should I|Allow|Trust|Proceed/i.test(data);
        
        if (isPrompt) {
          console.log('PROMPT DETECTED:', data);
        }
        
        mainWindow.webContents.send('q-output', {
          sessionId,
          data: data,
          isPrompt
        });
      });
      
      // Handle process exit
      qProcess.onExit((code, signal) => {
        console.log('Q CLI process exited with code:', code, 'signal:', signal);
        sessions.delete(sessionId);
        
        // Log error details to console instead of showing popup
        if (code !== 0 && code !== null) {
          console.error(`Q CLI failed to start (exit code: ${code})`);
          console.error('Possible causes:');
          console.error('• Q CLI not installed or not in PATH');
          console.error('• Missing AWS credentials');
          console.error('• MCP server configuration issues');
          console.error('• MCP servers not found in PATH');
          console.error('Check the console output for details.');
        }
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-closed', { sessionId, code });
        }
      });
      
    } else {
      console.log('Using child_process fallback for session creation with path:', qCliPath);
      console.log('Working directory:', userHome);
      console.log('Comprehensive PATH:', comprehensivePath);
      const { spawn } = require('child_process');
      // Fallback to original spawn method
      qProcess = spawn(qCliPath, ['chat'], { 
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        cwd: userHome, // Set working directory to user home
        env: {
          ...process.env,
          HOME: userHome, // Ensure HOME is set
          USERPROFILE: userHome, // For Windows compatibility
          PATH: comprehensivePath // Extended PATH for MCP servers
        }
      });
      
      sessions.set(sessionId, { process: qProcess, state: 'ready', type: 'spawn' });
      
      qProcess.stdout.on('data', (data) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          console.log('Window closed, ignoring Q CLI stdout');
          return;
        }
        
        const text = data.toString();
        const isPrompt = /\(y\/n\)|Do you want to continue\?|Can I|Should I|Allow|Trust|Proceed/i.test(text);
        
        if (isPrompt) {
          console.log('PROMPT DETECTED:', text);
        }
        
        mainWindow.webContents.send('q-output', {
          sessionId,
          data: text,
          isPrompt
        });
      });
      
      qProcess.stderr.on('data', (data) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          console.log('Window closed, ignoring Q CLI stderr');
          return;
        }
        
        mainWindow.webContents.send('q-output', {
          sessionId,
          data: data.toString(),
          isError: true
        });
      });
      
      qProcess.on('close', (code) => {
        console.log('Q CLI process closed with code:', code);
        sessions.delete(sessionId);
        
        // Log error details to console instead of showing popup
        if (code !== 0 && code !== null) {
          console.error(`Q CLI failed to start (exit code: ${code})`);
          console.error('Possible causes:');
          console.error('• Q CLI not installed or not in PATH');
          console.error('• Missing AWS credentials');
          console.error('• MCP server configuration issues');
          console.error('• MCP servers not found in PATH');
          console.error('Check the console output for details.');
        }
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-closed', { sessionId, code });
        }
      });
      
      qProcess.on('error', (error) => {
        console.error('Q CLI process error:', error.message);
        console.error('Failed to start Q CLI - please ensure:');
        console.error('• Amazon Q CLI is installed');
        console.error('• Q CLI is in your system PATH');
        console.error('• You have proper permissions');
        console.error('• MCP servers are installed and accessible');
        console.error('Try running "q chat" in Terminal to verify installation.');
        
        sessions.delete(sessionId);
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-closed', { sessionId, code: -1, error: error.message });
        }
      });
    }
    
    console.log('Session created successfully:', sessionId);
    return sessionId;
    
  } catch (error) {
    console.error('Error creating session:', error.message);
    console.error('This usually indicates:');
    console.error('• Q CLI installation issues');
    console.error('• Permission problems');
    console.error('• System configuration errors');
    console.error('• MCP server path issues');
    console.error('Please check your Q CLI installation.');
    
    throw error;
  }
});

ipcMain.handle('send-to-q', (event, { sessionId, input }) => {
  const session = sessions.get(sessionId);
  if (session && session.process) {
    try {
      if (session.type === 'pty') {
        // Clean up input but preserve intentional formatting
        const cleanInput = input.trim();
        session.process.write(cleanInput + '\r');
      } else {
        session.process.stdin.write(input + '\n');
      }
      return true;
    } catch (error) {
      console.error('Error sending input:', error);
      return false;
    }
  }
  return false;
});

ipcMain.handle('kill-session', (event, sessionId) => {
  const session = sessions.get(sessionId);
  if (session && session.process) {
    session.process.kill();
    sessions.delete(sessionId);
    return true;
  }
  return false;
});

// Chat Management
ipcMain.handle('save-chat', async (event, { title, content }) => {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }
  
  return new Promise((resolve) => {
    // Check if we're at the limit
    db.get('SELECT COUNT(*) as count FROM saved_chats', (err, row) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      
      if (row.count >= 100) {
        resolve({ success: false, error: 'Maximum 100 saved chats reached. Delete some chats first.' });
        return;
      }
      
      // Insert new chat
      db.run('INSERT INTO saved_chats (title, content) VALUES (?, ?)', [title, content], function(err) {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true, id: this.lastID });
        }
      });
    });
  });
});

ipcMain.handle('get-chat-list', async () => {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }
  
  return new Promise((resolve) => {
    db.all('SELECT id, title, created_at FROM saved_chats ORDER BY created_at DESC', (err, rows) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, chats: rows });
      }
    });
  });
});

ipcMain.handle('load-chat', async (event, chatId) => {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }
  
  return new Promise((resolve) => {
    db.get('SELECT * FROM saved_chats WHERE id = ?', [chatId], (err, row) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else if (!row) {
        resolve({ success: false, error: 'Chat not found' });
      } else {
        resolve({ success: true, content: row.content, title: row.title });
      }
    });
  });
});

ipcMain.handle('delete-chat', async (event, chatId) => {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }
  
  return new Promise((resolve) => {
    db.run('DELETE FROM saved_chats WHERE id = ?', [chatId], function(err) {
      if (err) {
        resolve({ success: false, error: err.message });
      } else if (this.changes === 0) {
        resolve({ success: false, error: 'Chat not found' });
      } else {
        resolve({ success: true });
      }
    });
  });
});

ipcMain.handle('update-chat', async (event, { id, content }) => {
  if (!db) {
    return { success: false, error: 'Database not available' };
  }
  
  return new Promise((resolve) => {
    db.run('UPDATE saved_chats SET content = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?', [content, id], function(err) {
      if (err) {
        resolve({ success: false, error: err.message });
      } else if (this.changes === 0) {
        resolve({ success: false, error: 'Chat not found' });
      } else {
        resolve({ success: true });
      }
    });
  });
});

// MCP Config Management
ipcMain.handle('get-mcp-config', async () => {
  const configPath = path.join(os.homedir(), '.aws', 'amazonq', 'mcp.json');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return { success: true, content, path: configPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-mcp-config', async (event, content) => {
  const configPath = path.join(os.homedir(), '.aws', 'amazonq', 'mcp.json');
  const backupPath = configPath + '.backup.' + Date.now();
  
  try {
    // Create backup
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, backupPath);
    }
    
    // Validate JSON
    JSON.parse(content);
    
    // Save new content
    fs.writeFileSync(configPath, content, 'utf8');
    return { success: true, backupPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// File System Operations
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const files = fs.readdirSync(filePath).map(name => {
        const fullPath = path.join(filePath, name);
        const stat = fs.statSync(fullPath);
        return {
          name,
          path: fullPath,
          isDirectory: stat.isDirectory(),
          size: stat.size,
          modified: stat.mtime
        };
      });
      return { success: true, isDirectory: true, files };
    } else {
      const content = fs.readFileSync(filePath, 'utf8');
      return { success: true, isDirectory: false, content, stats };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-file-external', async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// App Control
ipcMain.handle('close-app', async () => {
  try {
    console.log('Close app requested, cleaning up...');
    
    // Kill all Q processes
    sessions.forEach(session => {
      if (session.process) {
        try {
          session.process.kill('SIGTERM');
          console.log('Killed session process');
        } catch (error) {
          console.error('Error killing session:', error);
        }
      }
    });
    sessions.clear();
    
    // Set mainWindow to null to prevent further IPC calls
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow = null;
    }
    
    // Close the app after a brief delay to ensure cleanup
    setTimeout(() => {
      app.quit();
    }, 100);
    
    return { success: true };
  } catch (error) {
    console.error('Error closing app:', error);
    app.quit(); // Force quit on error
    return { success: false, error: error.message };
  }
});

// Report Export Handler
ipcMain.handle('save-report', async (event, filename, htmlContent) => {
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Saving report attempt ${attempt + 1}/${maxRetries}:`, filename);
      
      // Validate inputs
      if (!filename || typeof filename !== 'string') {
        throw new Error('Invalid filename provided');
      }
      
      if (!htmlContent || typeof htmlContent !== 'string') {
        throw new Error('Invalid HTML content provided');
      }
      
      // Sanitize filename
      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
      console.log('Sanitized filename:', sanitizedFilename);
      
      // Try multiple save locations in order of preference
      const saveLocations = [
        path.join(os.homedir(), 'Downloads'),
        path.join(os.homedir(), 'Documents'),
        path.join(process.cwd(), 'exports'),
        os.tmpdir()
      ];
      
      let savedPath = null;
      let saveError = null;
      
      for (const location of saveLocations) {
        try {
          // Ensure directory exists
          if (!fs.existsSync(location)) {
            fs.mkdirSync(location, { recursive: true });
          }
          
          const filePath = path.join(location, sanitizedFilename);
          console.log('Attempting to save to:', filePath);
          
          // Check if file already exists and create unique name
          let finalPath = filePath;
          let counter = 1;
          while (fs.existsSync(finalPath)) {
            const ext = path.extname(sanitizedFilename);
            const name = path.basename(sanitizedFilename, ext);
            finalPath = path.join(location, `${name}_${counter}${ext}`);
            counter++;
          }
          
          // Write file with proper encoding
          fs.writeFileSync(finalPath, htmlContent, { encoding: 'utf8', mode: 0o644 });
          
          // Verify file was written correctly
          const stats = fs.statSync(finalPath);
          if (stats.size === 0) {
            throw new Error('File was created but is empty');
          }
          
          console.log('Report saved successfully:', finalPath, 'Size:', stats.size);
          savedPath = finalPath;
          break;
          
        } catch (locationError) {
          console.warn(`Failed to save to ${location}:`, locationError.message);
          saveError = locationError;
          continue;
        }
      }
      
      if (!savedPath) {
        throw new Error(`Failed to save to any location. Last error: ${saveError?.message || 'Unknown error'}`);
      }
      
      return { 
        success: true, 
        filePath: savedPath,
        size: fs.statSync(savedPath).size
      };
      
    } catch (error) {
      console.error(`Save attempt ${attempt + 1} failed:`, error);
      lastError = error;
      
      if (attempt < maxRetries - 1) {
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }
  
  console.error('All save attempts failed:', lastError);
  return { 
    success: false, 
    error: `Failed to save report after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}` 
  };
});

// App lifecycle - proper Electron pattern
app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  // Kill all Q processes
  sessions.forEach(session => {
    if (session.process) {
      try {
        session.process.kill();
      } catch (error) {
        console.error('Error killing session:', error);
      }
    }
  });
  sessions.clear();
  
  // Always quit when all windows are closed
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
