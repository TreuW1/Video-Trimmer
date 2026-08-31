import type { UploadQueueItem, VideoTrack } from '$lib/types/editor';

export type EditorMediaPickerMode = 'add' | 'replace';

export const EDITOR_MEDIA_PICKER_MODE_KEY = 'editorMediaPickerMode';

type EditorSession = {
  tracks: VideoTrack[];
  activeTrackId: string | null;
  uploadQueue: UploadQueueItem[];
};

let editorSession: EditorSession | null = null;

function copyTrack(track: VideoTrack): VideoTrack {
  return {
    ...track,
    trimRanges: track.trimRanges?.map((range) => ({ ...range })),
    audioMuteRanges: track.audioMuteRanges?.map((range) => ({ ...range }))
  };
}

function copyQueueItem(item: UploadQueueItem): UploadQueueItem {
  return {
    ...item,
    // An upload is stopped when the editor route is left. Resume it on return.
    status: item.status === 'uploading' ? 'pending' : item.status,
    progress: item.status === 'uploading' ? 0 : item.progress
  };
}

export function saveEditorSession(
  tracks: VideoTrack[],
  activeTrackId: string | null,
  uploadQueue: UploadQueueItem[]
): void {
  editorSession = {
    tracks: tracks.map(copyTrack),
    activeTrackId,
    uploadQueue: uploadQueue.map(copyQueueItem)
  };
}

export function restoreEditorSession(): EditorSession | null {
  if (!editorSession) return null;

  return {
    tracks: editorSession.tracks.map(copyTrack),
    activeTrackId: editorSession.activeTrackId,
    uploadQueue: editorSession.uploadQueue.map(copyQueueItem)
  };
}
