import { create } from 'zustand';

export type ThemeMode = 'dusk' | 'mist' | 'day';
export type InputSurface = 'transparent' | 'frosted';
export type SizePreference = 'small' | 'medium' | 'large';
export type EnterBehavior = 'send' | 'newline';
export type ImageReferenceQuality = 'standard' | 'high' | 'original';
export type MultiAlignMode = 'hold' | 'click' | 'off';
export type NodeDirection = 'right' | 'down';
export type ShortcutPreset = 'native' | 'canvaspro';
export type ApiProviderId = 'anycap' | 'sub2api' | 'openai-compatible' | 'runninghub';

export type ProviderDrafts = Record<ApiProviderId, { endpoint: string; apiKey: string }>;

export interface StudioSettings {
  language: 'zh-CN' | 'en-US';
  theme: ThemeMode;
  inputSurface: InputSurface;
  cursorSize: SizePreference;
  inputFontSize: SizePreference;
  enterBehavior: EnterBehavior;
  imageReferenceQuality: ImageReferenceQuality;
  completionSound: boolean;
  cornerNotification: boolean;
  promptVolume: number;
  gridVisible: boolean;
  connectionVisible: boolean;
  highlightConnections: boolean;
  highlightColor: string;
  guideSnap: boolean;
  gridSnap: boolean;
  multiAlignMode: MultiAlignMode;
  alignSpacing: number;
  videoNodeInfo: boolean;
  titleScaleWithCanvas: boolean;
  mediaNodeResize: boolean;
  composerResizable: boolean;
  noteJumpX: number;
  noteJumpY: number;
  newNodeSpacing: number;
  newNodeDirection: NodeDirection;
  newNodeAvoidOverlap: boolean;
  saveRoot: string;
  shortcutPreset: ShortcutPreset;
}

interface SettingsStore {
  settings: StudioSettings;
  providerDrafts: ProviderDrafts;
  setSetting: <Key extends keyof StudioSettings>(key: Key, value: StudioSettings[Key]) => void;
  setProviderDraft: (providerId: ApiProviderId, patch: Partial<ProviderDrafts[ApiProviderId]>) => void;
  patchSettings: (patch: Partial<StudioSettings>) => void;
  resetSettings: () => void;
}

export const SETTINGS_STORAGE_KEY = 'selfcanvas.settings.v1';

export const defaultSettings: StudioSettings = {
  language: 'zh-CN',
  theme: 'dusk',
  inputSurface: 'frosted',
  cursorSize: 'small',
  inputFontSize: 'small',
  enterBehavior: 'send',
  imageReferenceQuality: 'high',
  completionSound: true,
  cornerNotification: true,
  promptVolume: 70,
  gridVisible: true,
  connectionVisible: true,
  highlightConnections: true,
  highlightColor: '#ffffff',
  guideSnap: true,
  gridSnap: false,
  multiAlignMode: 'click',
  alignSpacing: 40,
  videoNodeInfo: false,
  titleScaleWithCanvas: false,
  mediaNodeResize: false,
  composerResizable: true,
  noteJumpX: 50,
  noteJumpY: 20,
  newNodeSpacing: 120,
  newNodeDirection: 'right',
  newNodeAvoidOverlap: true,
  saveRoot: '',
  shortcutPreset: 'native',
};

export const defaultProviderDrafts: ProviderDrafts = {
  anycap: { endpoint: '', apiKey: '' },
  sub2api: { endpoint: '', apiKey: '' },
  'openai-compatible': { endpoint: '', apiKey: '' },
  runninghub: { endpoint: '', apiKey: '' },
};

function readSettings(): StudioSettings {
  if (typeof window === 'undefined') return defaultSettings;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw) as Partial<StudioSettings>;
    return { ...defaultSettings, ...parsed };
  } catch {
    return defaultSettings;
  }
}

function saveSettings(settings: StudioSettings) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: readSettings(),
  providerDrafts: defaultProviderDrafts,
  setSetting: (key, value) =>
    set((state) => {
      const settings = { ...state.settings, [key]: value };
      saveSettings(settings);
      return { settings };
    }),
  setProviderDraft: (providerId, patch) =>
    set((state) => ({
      providerDrafts: {
        ...state.providerDrafts,
        [providerId]: { ...state.providerDrafts[providerId], ...patch },
      },
    })),
  patchSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings, ...patch };
      saveSettings(settings);
      return { settings };
    }),
  resetSettings: () =>
    set(() => {
      saveSettings(defaultSettings);
      return { settings: defaultSettings };
    }),
}));
