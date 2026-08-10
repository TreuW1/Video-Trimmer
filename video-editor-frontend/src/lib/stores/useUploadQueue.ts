import type { UploadQueueItem } from '$lib/types/editor';

export function getUploadQueueFileName(file: File | null, filePath?: string | null): string {
  return file ? file.name : filePath ? filePath.split(/[\\/]/).pop() || 'video.mp4' : 'unknown';
}

export function getUploadQueueFileSize(file: File | null): number {
  return file ? file.size : 0;
}

export function getCompletedUploadQueueCount(uploadQueue: UploadQueueItem[]): number {
  return uploadQueue.filter((item) => item.status === 'completed' || item.status === 'skipped').length;
}

export function createUploadQueueItem(file: File | null, trackId: string, filePath?: string): UploadQueueItem {
  return {
    file: file || null,
    filePath: filePath || null,
    trackId,
    status: 'pending',
    progress: 0,
    videoId: null,
    error: null
  };
}

export function findReusableUploadQueueItem(
  uploadQueue: UploadQueueItem[],
  file: File | null,
  filePath?: string
): UploadQueueItem | undefined {
  if (filePath) {
    return uploadQueue.find(
      (item) =>
        item.filePath === filePath &&
        (item.status === 'completed' || item.status === 'uploading' || item.status === 'pending')
    );
  }

  const fileName = getUploadQueueFileName(file, filePath);
  const fileSize = getUploadQueueFileSize(file);

  return uploadQueue.find((item) => {
    const itemFileName = getUploadQueueFileName(item.file, item.filePath);
    const itemFileSize = getUploadQueueFileSize(item.file);
    return (
      itemFileName === fileName &&
      (fileSize === 0 || itemFileSize === 0 || itemFileSize === fileSize) &&
      (item.status === 'completed' || item.status === 'uploading' || item.status === 'pending')
    );
  });
}

