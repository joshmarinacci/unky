import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

const testPluginReady = import.meta.env.MODE === 'desktop-test'
  ? import('@wdio/tauri-plugin')
  : Promise.resolve();

void testPluginReady.then(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
});
