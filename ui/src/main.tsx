import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/geist-mono/latin-400.css';
import 'asciinema-player/dist/bundle/asciinema-player.css';
import { App } from './App';
import './styles/tokens.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/runs.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
