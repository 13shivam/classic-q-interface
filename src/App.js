import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [sessionId, setSessionId] = useState(null);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isWaitingForPrompt, setIsWaitingForPrompt] = useState(false);
  const [currentView, setCurrentView] = useState('chat'); // chat, config, files
  const [mcpConfig, setMcpConfig] = useState('');
  const [configPath, setConfigPath] = useState('');
  const outputRef = useRef(null);

  useEffect(() => {
    initializeSession();
    
    // Setup event listeners
    window.electronAPI.onQOutput((event, data) => {
      if (data.sessionId === sessionId) {
        const formattedOutput = linkifyPaths(data.data);
        setOutput(prev => prev + formattedOutput);
        setIsWaitingForPrompt(data.isPrompt);
        
        // Auto-scroll
        setTimeout(() => {
          if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
          }
        }, 10);
      }
    });

    window.electronAPI.onSessionClosed((event, data) => {
      if (data.sessionId === sessionId) {
        setIsConnected(false);
        setOutput(prev => prev + `\n[Session ended with code ${data.code}]\n`);
      }
    });

    return () => {
      if (sessionId) {
        window.electronAPI.killSession(sessionId);
      }
      window.electronAPI.removeAllListeners();
    };
  }, [sessionId]);

  const initializeSession = async () => {
    try {
      const newSessionId = await window.electronAPI.createSession();
      setSessionId(newSessionId);
      setIsConnected(true);
      setOutput('Q CLI Interface Ready\n\n');
    } catch (error) {
      setOutput(`Error: ${error.message}\n`);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || !sessionId) return;
    
    const message = input.trim();
    setOutput(prev => prev + `> ${message}\n`);
    setInput('');
    
    await window.electronAPI.sendToQ(sessionId, message);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      sendMessage();
    }
  };

  const clearOutput = () => setOutput('');
  
  const clearSession = async () => {
    if (sessionId) {
      await window.electronAPI.killSession(sessionId);
    }
    await initializeSession();
  };

  const linkifyPaths = (text) => {
    const pathRegex = /(\/[\w\-\.\/~]+|\.\/[\w\-\.\/]+|~\/[\w\-\.\/]+)/g;
    return text.replace(pathRegex, (match) => 
      `<span class="file-link" onclick="window.openFile('${match}')">📁 ${match}</span>`
    );
  };

  // Global function for file links
  window.openFile = async (filePath) => {
    try {
      const result = await window.electronAPI.readFile(filePath);
      if (result.success) {
        if (result.isDirectory) {
          setOutput(prev => prev + `\nDirectory: ${filePath}\n${result.files.map(f => 
            `${f.isDirectory ? '📂' : '📄'} ${f.name}`
          ).join('\n')}\n\n`);
        } else {
          await window.electronAPI.openFileExternal(filePath);
        }
      }
    } catch (error) {
      setOutput(prev => prev + `\nError opening file: ${error.message}\n`);
    }
  };

  const loadMcpConfig = async () => {
    const result = await window.electronAPI.getMcpConfig();
    if (result.success) {
      setMcpConfig(result.content);
      setConfigPath(result.path);
    } else {
      setMcpConfig(`Error loading config: ${result.error}`);
    }
  };

  const saveMcpConfig = async () => {
    const result = await window.electronAPI.saveMcpConfig(mcpConfig);
    if (result.success) {
      alert(`Config saved! Backup created at: ${result.backupPath}`);
    } else {
      alert(`Error saving config: ${result.error}`);
    }
  };

  useEffect(() => {
    if (currentView === 'config') {
      loadMcpConfig();
    }
  }, [currentView]);

  return (
    <div className="app">
      <header className="header">
        <h1>Q CLI Interface</h1>
        <nav>
          <button 
            className={currentView === 'chat' ? 'active' : ''} 
            onClick={() => setCurrentView('chat')}
          >
            Chat
          </button>
          <button 
            className={currentView === 'config' ? 'active' : ''} 
            onClick={() => setCurrentView('config')}
          >
            Config
          </button>
        </nav>
        <div className="status">
          Status: <span className={isConnected ? 'connected' : 'disconnected'}>
            {isConnected ? '●' : '○'}
          </span>
        </div>
      </header>

      {currentView === 'chat' && (
        <div className="chat-view">
          <div className="input-section">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder={isWaitingForPrompt ? "Enter y/n response..." : "Enter your Q CLI command..."}
              className={isWaitingForPrompt ? 'prompt-mode' : ''}
            />
            <div className="input-controls">
              <button onClick={sendMessage} disabled={!input.trim()}>
                Send
              </button>
              <button onClick={() => setInput('')}>Clear</button>
              <button onClick={clearSession}>New Session</button>
              <span className="char-count">{input.length} chars</span>
            </div>
          </div>

          <div className="output-section">
            <div className="output-controls">
              <button onClick={clearOutput}>Clear Output</button>
              <button onClick={() => navigator.clipboard.writeText(output)}>
                Copy
              </button>
            </div>
            <pre 
              ref={outputRef}
              className="output"
              dangerouslySetInnerHTML={{ __html: output }}
            />
          </div>
        </div>
      )}

      {currentView === 'config' && (
        <div className="config-view">
          <div className="config-header">
            <h2>MCP Configuration</h2>
            <p>File: {configPath}</p>
            <div className="config-controls">
              <button onClick={loadMcpConfig}>Reload</button>
              <button onClick={saveMcpConfig}>Save</button>
            </div>
          </div>
          <textarea
            value={mcpConfig}
            onChange={(e) => setMcpConfig(e.target.value)}
            className="config-editor"
            placeholder="Loading MCP configuration..."
          />
        </div>
      )}
    </div>
  );
}

export default App;
