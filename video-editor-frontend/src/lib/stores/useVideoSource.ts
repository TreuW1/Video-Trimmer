import type { VideoTrack } from '$lib/types/editor';

export function createVideoSourceManager() {
  const objectUrlCache = new WeakMap<File, string>();
  const cachedObjectUrls = new Set<string>();
  const filePathUrlCache = new Map<string, string>();
  let convertFileSrcPromise: Promise<(path: string) => string> | null = null;

  async function getVideoSourceUrl(track: Pick<VideoTrack, 'videoFile' | 'filePath'>): Promise<string | null> {
    if (track.filePath) {
      const cachedUrl = filePathUrlCache.get(track.filePath);
      if (cachedUrl) return cachedUrl;

      convertFileSrcPromise ??= import('@tauri-apps/api/core').then(({ convertFileSrc }) => convertFileSrc);
      const convertFileSrc = await convertFileSrcPromise;
      const url = convertFileSrc(track.filePath);
      filePathUrlCache.set(track.filePath, url);
      return url;
    }

    if (track.videoFile) {
      const cachedUrl = objectUrlCache.get(track.videoFile);
      if (cachedUrl) return cachedUrl;

      const url = URL.createObjectURL(track.videoFile);
      objectUrlCache.set(track.videoFile, url);
      cachedObjectUrls.add(url);
      return url;
    }

    return null;
  }

  function dispose(): void {
    for (const url of cachedObjectUrls) {
      URL.revokeObjectURL(url);
    }
    cachedObjectUrls.clear();
    filePathUrlCache.clear();
  }

  return {
    getVideoSourceUrl,
    dispose
  };
}

