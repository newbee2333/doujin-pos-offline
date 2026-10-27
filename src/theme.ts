import { create } from 'zustand';

export type ThemePreference = 'system' | 'light' | 'dark';
export type LightPalette = 'default' | 'warm';
const STORAGE_KEY = 'doujin-pos:theme';
const PALETTE_KEY = 'doujin-pos:light-theme';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function readPalette(): LightPalette {
  try { return localStorage.getItem(PALETTE_KEY) === 'warm' ? 'warm' : 'default'; } catch { return 'default'; }
}

function applyTheme(preference: ThemePreference, palette: LightPalette) {
  const dark = preference === 'dark' || (preference === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : palette === 'warm' ? 'warm' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1b1e26' : palette === 'warm' ? '#fffdf8' : '#ffffff');
}

// Appearance belongs to this browser/device, independently of the business database.
export const useTheme = create<{
  preference: ThemePreference;
  lightPalette: LightPalette;
  storageError: boolean;
  setPreference: (preference: ThemePreference) => void;
  setLightPalette: (palette: LightPalette) => void;
}>((set) => ({
  preference: readPreference(),
  lightPalette: readPalette(),
  storageError: false,
  setPreference(preference) {
    let storageError = false;
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      storageError = true;
    }
    applyTheme(preference, useTheme.getState().lightPalette);
    set({ preference, storageError });
  },
  setLightPalette(lightPalette) {
    let storageError = false;
    try { localStorage.setItem(PALETTE_KEY, lightPalette); } catch { storageError = true; }
    applyTheme(useTheme.getState().preference, lightPalette);
    set({ lightPalette, storageError });
  }
}));

export function initializeTheme() {
  const applyCurrent = () => { const state = useTheme.getState(); applyTheme(state.preference, state.lightPalette); };
  applyCurrent();
  systemTheme.addEventListener('change', applyCurrent);
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== PALETTE_KEY && event.key !== null) return;
    const preference = readPreference();
    const lightPalette = readPalette();
    useTheme.setState({ preference, lightPalette, storageError: false });
    applyTheme(preference, lightPalette);
  });
}
