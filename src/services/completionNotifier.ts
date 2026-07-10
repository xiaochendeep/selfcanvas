import type { NodeKind } from '../types';
import { useSettingsStore } from '../store/settingsStore';

export const COMPLETION_NOTICE_EVENT = 'selfcanvas:generation-complete';

export interface CompletionNoticeDetail {
  title: string;
  kind: NodeKind;
  completedAt: string;
}

let audioContext: AudioContext | null = null;

function getAudioContext() {
  if (audioContext || typeof window === 'undefined') return audioContext;
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return null;
  audioContext = new AudioContextConstructor();
  return audioContext;
}

export function prepareCompletionFeedback() {
  if (!useSettingsStore.getState().settings.completionSound) return;
  const context = getAudioContext();
  if (context?.state === 'suspended') void context.resume();
}

function playCompletionTone(volume: number) {
  const context = getAudioContext();
  if (!context) return;
  const start = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.13), start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
  gain.connect(context.destination);

  [660, 880].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start + index * 0.08);
    oscillator.connect(gain);
    oscillator.start(start + index * 0.08);
    oscillator.stop(start + 0.34);
  });
}

export function previewCompletionTone() {
  const settings = useSettingsStore.getState().settings;
  prepareCompletionFeedback();
  playCompletionTone(settings.promptVolume / 100);
}

export function notifyGenerationComplete(title: string, kind: NodeKind) {
  if (typeof window === 'undefined') return;
  const settings = useSettingsStore.getState().settings;
  if (settings.completionSound) playCompletionTone(settings.promptVolume / 100);

  const detail: CompletionNoticeDetail = { title, kind, completedAt: new Date().toISOString() };
  if (settings.cornerNotification) {
    window.dispatchEvent(new CustomEvent<CompletionNoticeDetail>(COMPLETION_NOTICE_EVENT, { detail }));
  }

  if (
    settings.cornerNotification &&
    document.visibilityState !== 'visible' &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    new Notification('SelfCanvas 生成完成', { body: `${title} 已生成完成。` });
  }
}
