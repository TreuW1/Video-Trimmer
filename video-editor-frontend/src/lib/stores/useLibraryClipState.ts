import { browser } from '$app/environment';
import type { LibraryClipState } from '$lib/types/editor';

const LIBRARY_CLIP_STATE_KEY = 'video_library_clip_state';

const VIDEO_FILE_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'm4v',
  'mkv',
  'webm',
  'avi',
  'wmv',
  'flv',
  'mpeg',
  'mpg',
  '3gp',
  'ts'
]);

function loadLibraryClipStates(): Record<string, LibraryClipState> {
  if (!browser) return {};

  try {
    const raw = localStorage.getItem(LIBRARY_CLIP_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function loadLibraryClipState(filePath: string): LibraryClipState | null {
  return loadLibraryClipStates()[filePath] ?? null;
}

export function saveLibraryClipState(filePath: string, state: LibraryClipState): void {
  if (!browser) return;

  try {
    const states = loadLibraryClipStates();
    states[filePath] = {
      ...states[filePath],
      ...state
    };
    localStorage.setItem(LIBRARY_CLIP_STATE_KEY, JSON.stringify(states));
  } catch (error) {
    console.warn('Failed to persist library clip state:', error);
  }
}

export function isVideoPath(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase();
  return !!extension && VIDEO_FILE_EXTENSIONS.has(extension);
}
