import { create } from 'zustand';

export type ThemePreference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'doujin-pos:theme';
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

function applyTheme(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1b1e26' : '#ffffff');
}

// Appearance belongs to this browser/device, independently of the business database.
export const useTheme = create<{
  preference: ThemePreference;
  storageError: boolean;
  setPreference: (preference: ThemePreference) => void;
}>((set) => ({
  preference: readPreference(),
  storageError: false,
  setPreference(preference) {
    let storageError = false;
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      storageError = true;
    }
    applyTheme(preference);
    set({ preference, storageError });
  }
}));

export function initializeTheme() {
  applyTheme(useTheme.getState().preference);
  systemTheme.addEventListener('change', () => applyTheme(useTheme.getState().preference));
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const preference = readPreference();
    useTheme.setState({ preference, storageError: false });
    applyTheme(preference);
  });
}
