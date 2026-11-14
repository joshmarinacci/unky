import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AddressSuggestionsPopup from './AddressSuggestionsPopup';
import { applyOsTextSizes } from './osTextSizes';
import './style.css';
// React Aria's Vanilla CSS starter styles, adapted with a warm orange tint.
import './react-aria-theme/Button.css';
import './react-aria-theme/TextField.css';
import './react-aria-theme/Tabs.css';
import './react-aria-theme/Tree.css';
import './react-aria-theme/Select.css';
import './react-aria-theme/ListBox.css';
import './react-aria-theme/Popover.css';
import './react-aria-theme/DropZone.css';

const addressPopup = new URLSearchParams(window.location.search).get('page') === 'address-suggestions';
const testPluginReady = import.meta.env.MODE === 'desktop-test' && !addressPopup
  ? import('@wdio/tauri-plugin')
  : Promise.resolve();

void testPluginReady.then(() => {
  applyOsTextSizes();
  createRoot(document.getElementById('root')!).render(<React.StrictMode>{addressPopup ? <AddressSuggestionsPopup /> : <App />}</React.StrictMode>);
});
