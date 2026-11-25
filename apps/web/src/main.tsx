import './monacoSetup.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(<App />);
