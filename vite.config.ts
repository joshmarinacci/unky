import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // UNKY_DEV_PORT lets scripted runs (such as the macOS session test) avoid another dev server on 1420.
  server: { port: Number(process.env.UNKY_DEV_PORT) || 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13' },
});
