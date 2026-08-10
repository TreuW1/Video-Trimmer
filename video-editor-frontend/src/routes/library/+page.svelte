<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { parseTime } from '$lib/utils/time';
  import {
    EDITOR_MEDIA_PICKER_MODE_KEY,
    type EditorMediaPickerMode
  } from '$lib/stores/useEditorSession';
  
  interface VideoFile {
    path: string;
    name: string;
    size: number;
    thumbnail: string | null;
    duration: number;
    createdAt?: number;
  }
  
  interface LibraryCache {
    directory: string;
    videos: VideoFile[];
    timestamp: number;
  }
  
  let videos = $state<VideoFile[]>([]);
  let searchQuery = $state('');
  let selectedDirectory = $state<string>('');
  let isLoading = $state(false);
  let hoveredVideo = $state<string | null>(null);
  let hoverTimeout: number | null = null;
  let previewVideo: HTMLVideoElement | null = null;
  let thumbnailCacheDir = $state<string>('');
  let isMounted = $state(false);
  let isPageVisible = $state(true);
  let videoPreviews = $state<Record<string, HTMLVideoElement | null>>({});
  let rememberedClipStates = $state<Record<string, LibraryClipState>>({});
  let openVideoMenu = $state<string | null>(null);
  let pendingDeleteVideo = $state<VideoFile | null>(null);
  let pendingRenameVideo = $state<VideoFile | null>(null);
  let renameValue = $state('');
  let isFileActionPending = $state(false);
  let renameInput = $state<HTMLInputElement | null>(null);
  
  
  // Multi-selection state
  let selectedVideos = $state<Set<string>>(new Set());
  let isSelectionMode = $derived(selectedVideos.size > 0);
  let mediaPickerMode = $state<EditorMediaPickerMode>('add');
  
  const CACHE_KEY = 'video_library_cache';
  const LIBRARY_CLIP_STATE_KEY = 'video_library_clip_state';
  const LIBRARY_SCROLL_TOP_KEY = 'video_library_scroll_top';
  const THUMBNAIL_CONCURRENCY = 3;

  type LibraryClipState = {
    startTime?: string;
    endTime?: string;
    compressionMode?: string;
    volume?: number;
    endTimeManuallySet?: boolean;
  };

  function loadLibraryClipStates(): Record<string, LibraryClipState> {
    if (!browser) return {};

    try {
      const raw = localStorage.getItem(LIBRARY_CLIP_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function getLibraryClipState(videoPath: string): LibraryClipState | null {
    return rememberedClipStates[videoPath] ?? null;
  }

  function refreshRememberedClipStates(): void {
    rememberedClipStates = loadLibraryClipStates();
  }
  
  // Intersection Observer for lazy loading
  let observer: IntersectionObserver | null = null;
  let visibleVideos = new Set<string>();
  let activeScanId = 0;
  let libraryScroller: HTMLDivElement | null = null;
  let libraryScrollTop = $state(0);
  let libraryViewportWidth = $state(0);
  let libraryViewportHeight = $state(0);
  let isInitialScanBatchPending = $state(false);
  let hasCheckedInitialLibraryCache = $state(false);
  let isWindowUnloading = false;
  let isGeneratingThumbnails = false;
  let hasPendingThumbnailGeneration = false;
  let unwatchLibraryDirectory: (() => void) | null = null;
  let libraryWatcherGeneration = 0;
  let libraryRefreshTimer: number | null = null;
  let isLibraryRefreshInProgress = false;
  let hasPendingLibraryRefresh = false;
  
  const GRID_GAP = 12;
  const GRID_PADDING = 24;
  const GRID_OVERSCAN_ROWS = 3;
  const SCAN_BATCH_SIZE = 40;
  const LIBRARY_WATCH_DEBOUNCE_MS = 250;
  const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v'];
  
  // Status notification
  let showStatusNotification = $state(false);
  let statusNotificationMessage = $state('');
  let statusNotificationType = $state<'success' | 'error' | 'info'>('info');
  // Filtered and sorted videos
  let filteredVideos = $state<VideoFile[]>([]);
  
  let virtualColumnCount = $derived(getGridColumnCount(libraryViewportWidth));
  let virtualGridWidth = $derived(Math.max(libraryViewportWidth - GRID_PADDING * 2, 0));
  let virtualColumnWidth = $derived(
    virtualColumnCount > 0
      ? (virtualGridWidth - GRID_GAP * (virtualColumnCount - 1)) / virtualColumnCount
      : 0
  );
  let virtualCardHeight = $derived(Math.ceil((virtualColumnWidth * 9) / 16 + 66));
  let virtualRowHeight = $derived(virtualCardHeight + GRID_GAP);
  let virtualTotalRows = $derived(Math.ceil(filteredVideos.length / virtualColumnCount));
  let virtualStartRow = $derived(
    Math.max(0, Math.floor(libraryScrollTop / virtualRowHeight) - GRID_OVERSCAN_ROWS)
  );
  let virtualVisibleRows = $derived(
    Math.ceil(libraryViewportHeight / virtualRowHeight) + GRID_OVERSCAN_ROWS * 2
  );
  let virtualEndRow = $derived(Math.min(virtualTotalRows, virtualStartRow + virtualVisibleRows));
  let virtualStartIndex = $derived(virtualStartRow * virtualColumnCount);
  let virtualEndIndex = $derived(Math.min(filteredVideos.length, virtualEndRow * virtualColumnCount));
  let virtualVideos = $derived(filteredVideos.slice(virtualStartIndex, virtualEndIndex));
  let virtualTopOffset = $derived(virtualStartRow * virtualRowHeight);
  let virtualTotalHeight = $derived(Math.max(0, virtualTotalRows * virtualRowHeight - GRID_GAP));
  
  function getGridColumnCount(width: number): number {
    if (width >= 1280) return 4;
    if (width >= 768) return 3;
    return 2;
  }
  
  function handleLibraryScroll() {
    libraryScrollTop = libraryScroller?.scrollTop || 0;
    saveLibraryScrollPosition();
  }

  function getSavedLibraryScrollPosition(): number {
    if (!browser) return 0;

    const rawScrollTop = sessionStorage.getItem(LIBRARY_SCROLL_TOP_KEY);
    const savedScrollTop = rawScrollTop ? Number(rawScrollTop) : 0;
    return Number.isFinite(savedScrollTop) && savedScrollTop > 0 ? savedScrollTop : 0;
  }

  function saveLibraryScrollPosition(): void {
    if (!browser) return;
    sessionStorage.setItem(LIBRARY_SCROLL_TOP_KEY, String(libraryScrollTop));
  }

  function resetLibraryScrollPosition(): void {
    libraryScrollTop = 0;
    if (libraryScroller) {
      libraryScroller.scrollTop = 0;
    }
    if (browser) {
      sessionStorage.removeItem(LIBRARY_SCROLL_TOP_KEY);
    }
  }

  function clearLibraryScrollPosition(): void {
    if (!browser) return;
    sessionStorage.removeItem(LIBRARY_SCROLL_TOP_KEY);
  }

  function handleWindowBeforeUnload(): void {
    isWindowUnloading = true;
    clearLibraryScrollPosition();
  }

  async function restoreLibraryScrollPosition(): Promise<void> {
    const savedScrollTop = getSavedLibraryScrollPosition();
    if (!savedScrollTop) return;

    libraryScrollTop = savedScrollTop;
    await tick();
    requestAnimationFrame(() => {
      if (!libraryScroller) return;
      libraryScroller.scrollTop = savedScrollTop;
      libraryScrollTop = libraryScroller.scrollTop;
    });
  }
  
  // Update filtered videos only when needed
  function updateFilteredVideos() {
    if (!isMounted) return;
    filteredVideos = videos
      .filter(video => 
        video.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
      .sort((a, b) => {
        const aTime = a.createdAt || 0;
        const bTime = b.createdAt || 0;
        return bTime - aTime;
      });
  }
  
  // Debounce search to reduce CPU usage
  let searchDebounceTimer: number | null = null;
  function handleSearchInput(e: Event) {
    const target = e.target as HTMLInputElement;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(() => {
      searchQuery = target.value;
      updateFilteredVideos();
    }, 150);
  }
  
  // Save library cache to localStorage
  function saveCache() {
    if (!browser || !isMounted) return;
    
    try {
      const cache: LibraryCache = {
        directory: selectedDirectory,
        videos: videos,
        timestamp: Date.now()
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (error) {
      // Silently fail
    }
  }
  
  // Load library cache from localStorage
  function loadCache(): LibraryCache | null {
    if (!browser) return null;
    
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      
      const cache: LibraryCache = JSON.parse(cached);
      
      return cache;
    } catch (error) {
      return null;
    }
  }
  
  // Check if running in Tauri
  let isTauri = $state(false);
  
  // Initialize thumbnail cache directory
  async function initThumbnailCache() {
    if (!browser || !isMounted) return;
    
    try {
      // @ts-ignore - Tauri API
      const { localDataDir, join } = await import('@tauri-apps/api/path');
      // @ts-ignore - Tauri API
      const { exists, mkdir } = await import('@tauri-apps/plugin-fs');
      
      thumbnailCacheDir = await join(await localDataDir(), 'VideoTrimmer', 'video-thumbnails');
      
      console.log('Thumbnail cache directory:', thumbnailCacheDir);
      
      // Check if directory exists
      const dirExists = await exists(thumbnailCacheDir);
      
      if (!dirExists) {
        console.log('Creating thumbnail cache directory...');
        await mkdir(thumbnailCacheDir, { recursive: true });
        console.log('Thumbnail cache directory created successfully');
      } else {
        console.log('Thumbnail cache directory already exists');
      }
    } catch (error) {
      console.error('Failed to initialize thumbnail cache:', error);
    }
  }
  
  // Get thumbnail file path for a video
  function getThumbnailPath(videoPath: string): string {
    // Create a simple hash from the video path
    let hash = 0;
    for (let i = 0; i < videoPath.length; i++) {
      const char = videoPath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    const separator = thumbnailCacheDir.includes('\\') ? '\\' : '/';
    return `${thumbnailCacheDir}${separator}thumb_${Math.abs(hash)}.jpg`;
  }
  
  // Check if thumbnail exists in cache
  async function thumbnailExists(videoPath: string): Promise<boolean> {
    if (!thumbnailCacheDir || !isMounted) return false;
    
    try {
      // @ts-ignore - Tauri API
      const { exists } = await import('@tauri-apps/plugin-fs');
      const thumbPath = getThumbnailPath(videoPath);
      const result = await exists(thumbPath);
      return result;
    } catch (error) {
      return false;
    }
  }
  
  // Load thumbnail from cache - returns URL immediately without checking existence
  async function loadThumbnailFromCache(videoPath: string, cacheVersion = 0): Promise<string | null> {
    if (!isMounted || !thumbnailCacheDir) return null;
    
    try {
      // @ts-ignore - Tauri API
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const thumbPath = getThumbnailPath(videoPath);
      
      // Just return the URL - the browser will handle if it doesn't exist
      const url = `${convertFileSrc(thumbPath)}?v=${cacheVersion}`;
      return url;
    } catch (error) {
      console.error('Failed to load thumbnail from cache:', error);
      return null;
    }
  }
  
  // Check if thumbnail actually exists (only used during initial scan)
  async function checkThumbnailExists(videoPath: string): Promise<boolean> {
    if (!thumbnailCacheDir || !isMounted) return false;
    
    try {
      // @ts-ignore - Tauri API
      const { exists } = await import('@tauri-apps/plugin-fs');
      const thumbPath = getThumbnailPath(videoPath);
      return await exists(thumbPath);
    } catch (error) {
      return false;
    }
  }
  
  // Save thumbnail to cache
  async function saveThumbnailToCache(videoPath: string, dataUrl: string): Promise<void> {
    if (!thumbnailCacheDir || !isMounted) return;
    
    try {
      // @ts-ignore - Tauri API
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      
      // Convert data URL to binary
      const base64Data = dataUrl.split(',')[1];
      const binaryData = atob(base64Data);
      const bytes = new Uint8Array(binaryData.length);
      for (let i = 0; i < binaryData.length; i++) {
        bytes[i] = binaryData.charCodeAt(i);
      }
      
      const thumbPath = getThumbnailPath(videoPath);
      console.log('Saving thumbnail to:', thumbPath);
      await writeFile(thumbPath, bytes);
      console.log('Thumbnail saved successfully');
    } catch (error) {
      console.error('Failed to save thumbnail:', error);
    }
  }
  
  // Function to select a directory using Tauri dialog
  async function selectDirectory() {
    if (!browser || !isMounted) return;
    
    // Check if running in Tauri
    try {
      // @ts-ignore - Check for Tauri API
      const { isTauri: checkTauri } = await import('@tauri-apps/api/core');
      isTauri = await checkTauri();
    } catch {
      isTauri = false;
    }
    
    if (!isTauri) {
      displayStatus('Folder selection is only available in the desktop app. Please use the desktop version.', 'error');
      return;
    }
    
    try {
      // @ts-ignore - Tauri API
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Video Library Folder'
      });
      
      if (selected) {
        selectedDirectory = selected as string;
        resetLibraryScrollPosition();
        await startLibraryDirectoryWatcher(selectedDirectory);
        await scanDirectory(selected as string);
      }
    } catch (error) {
      displayStatus('Failed to select directory', 'error');
    }
  }
  
  // Display status message
  function displayStatus(message: string, type: 'success' | 'error' | 'info') {
    statusNotificationMessage = message;
    statusNotificationType = type;
    showStatusNotification = true;
    
    setTimeout(() => {
      if (isMounted) {
        showStatusNotification = false;
      }
    }, 5000);
  }
  
  function getVideoFingerprint(video: VideoFile): string {
    return `${video.path}|${video.size}|${video.createdAt ?? 0}|${video.thumbnail ?? ''}`;
  }

  function hasVideoFileChanged(current: VideoFile, next: VideoFile): boolean {
    return current.size !== next.size || (current.createdAt ?? 0) !== (next.createdAt ?? 0);
  }

  function haveVideosChanged(currentVideos: VideoFile[], nextVideos: VideoFile[]): boolean {
    if (currentVideos.length !== nextVideos.length) return true;

    const currentFingerprints = currentVideos.map(getVideoFingerprint).sort();
    const nextFingerprints = nextVideos.map(getVideoFingerprint).sort();

    return currentFingerprints.some((fingerprint, index) => fingerprint !== nextFingerprints[index]);
  }

  function preserveGeneratedVideoData(nextVideos: VideoFile[], currentVideos: VideoFile[]): VideoFile[] {
    const currentByPath = new Map(currentVideos.map(video => [video.path, video]));

    return nextVideos.map(video => {
      const current = currentByPath.get(video.path);
      if (!current) return video;

      const fileChanged = hasVideoFileChanged(current, video);

      return {
        ...video,
        // The scan has already verified this URL against the thumbnail file on disk.
        // Do not restore a stale localStorage URL when that file has been deleted.
        thumbnail: video.thumbnail,
        duration: fileChanged ? video.duration : current.duration || video.duration
      };
    });
  }

  // Function to scan directory for video files
  async function scanDirectory(dirPath: string, options: { preserveScroll?: boolean; silent?: boolean } = {}) {
    if (!browser || !isMounted) return;
    
    const previousScrollTop = libraryScroller?.scrollTop ?? libraryScrollTop;
    const scanId = ++activeScanId;
    const currentVideos = videos;
    if (!options.silent) {
      isLoading = true;
      videos = [];
      updateFilteredVideos();
    }
    isInitialScanBatchPending = !options.silent;
    libraryScrollTop = options.preserveScroll ? previousScrollTop : 0;
    if (libraryScroller && !options.preserveScroll) {
      libraryScroller.scrollTop = 0;
    }
    
    try {
      // @ts-ignore - Tauri API
      const { readDir, stat } = await import('@tauri-apps/plugin-fs');
      
      const nextVideos: VideoFile[] = [];
      const currentByPath = new Map(currentVideos.map(video => [video.path, video]));
      let pendingBatch: VideoFile[] = [];
      let pendingFlush: Promise<void> | null = null;
      
      const flushBatch = async (immediate = false) => {
        if (scanId !== activeScanId || pendingBatch.length === 0) return;
        
        if (!immediate) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        
        if (scanId !== activeScanId || !isMounted) return;
        nextVideos.push(...pendingBatch);
        if (!options.silent) {
          videos = [...nextVideos];
          isInitialScanBatchPending = false;
          updateFilteredVideos();
          if (options.preserveScroll && libraryScroller) {
            libraryScroller.scrollTop = previousScrollTop;
          }
        }
        pendingBatch = [];
      };
      
      const queueVideo = async (video: VideoFile) => {
        pendingBatch.push(video);
        if (pendingBatch.length >= SCAN_BATCH_SIZE) {
          pendingFlush = flushBatch();
          await pendingFlush;
        }
      };
      
      const scanFolder = async (folderPath: string) => {
        if (!isMounted || scanId !== activeScanId) return;
        
        let entries: Awaited<ReturnType<typeof readDir>>;
        try {
          entries = await readDir(folderPath);
        } catch {
          return;
        }
        
        for (const entry of entries) {
          if (!isMounted || scanId !== activeScanId) break;
          
          const fullPath = joinPath(folderPath, entry.name);
          
          if (entry.isDirectory) {
            await scanFolder(fullPath);
            continue;
          }
          
          if (!entry.isFile || !isVideoFile(entry.name)) continue;
          
          try {
            const stats = await stat(fullPath);
            
            const size = stats.size || 0;
            const modifiedAt = stats.mtime ? new Date(stats.mtime).getTime() : 0;
            const previousVideo = currentByPath.get(fullPath);
            const fileChanged = previousVideo
              ? previousVideo.size !== size || (previousVideo.createdAt ?? 0) !== modifiedAt
              : false;

            let cachedThumbnail: string | null = null;
            if (!fileChanged && await checkThumbnailExists(fullPath)) {
              cachedThumbnail = await loadThumbnailFromCache(fullPath, modifiedAt);
            }
            
            await queueVideo({
              path: fullPath,
              name: entry.name,
              size,
              thumbnail: cachedThumbnail,
              duration: 0,
              createdAt: modifiedAt
            });
          } catch (error) {
            // Skip files that can't be accessed
          }
        }
      };
      
      await scanFolder(dirPath);
      if (pendingFlush) {
        await pendingFlush;
      }
      await flushBatch(true);
      
      if (scanId !== activeScanId || !isMounted) return;
      isLoading = false;
      isInitialScanBatchPending = false;

      if (options.silent) {
        const refreshedVideos = preserveGeneratedVideoData(nextVideos, currentVideos);
        if (!haveVideosChanged(currentVideos, refreshedVideos)) return;

        for (const refreshedVideo of refreshedVideos) {
          const currentVideo = currentByPath.get(refreshedVideo.path);
          if (!currentVideo || !hasVideoFileChanged(currentVideo, refreshedVideo)) continue;

          const preview = videoPreviews[refreshedVideo.path];
          if (preview) {
            preview.pause();
            preview.removeAttribute('src');
            preview.load();
          }
          if (hoveredVideo === refreshedVideo.path) {
            hoveredVideo = null;
          }
        }

        videos = refreshedVideos;
        updateFilteredVideos();
        if (options.preserveScroll && libraryScroller) {
          libraryScroller.scrollTop = previousScrollTop;
        }
      }
      
      // Save cache immediately after scanning
      saveCache();
      
      // Generate missing thumbnails in the background (non-blocking)
      if (isMounted && isPageVisible) {
        setTimeout(() => generateMissingThumbnails(), 100);
      }
    } catch (error) {
      if (scanId === activeScanId) {
        displayStatus('Failed to scan directory', 'error');
        isLoading = false;
        isInitialScanBatchPending = false;
      }
    }
  }

  function joinPath(dirPath: string, fileName: string): string {
    const separator = dirPath.includes('\\') ? '\\' : '/';
    const normalizedDir = dirPath.endsWith('\\') || dirPath.endsWith('/')
      ? dirPath.slice(0, -1)
      : dirPath;
    return `${normalizedDir}${separator}${fileName}`;
  }
  
  function isVideoFile(fileName: string): boolean {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex === -1) return false;
    return VIDEO_EXTENSIONS.includes(fileName.toLowerCase().substring(dotIndex));
  }

  function stopLibraryDirectoryWatcher(): void {
    libraryWatcherGeneration++;
    unwatchLibraryDirectory?.();
    unwatchLibraryDirectory = null;

    if (libraryRefreshTimer !== null) {
      clearTimeout(libraryRefreshTimer);
      libraryRefreshTimer = null;
    }
    hasPendingLibraryRefresh = false;
  }

  function scheduleLibraryRefresh(delay = LIBRARY_WATCH_DEBOUNCE_MS): void {
    hasPendingLibraryRefresh = true;
    if (!isMounted || !isPageVisible || !selectedDirectory) return;

    if (libraryRefreshTimer !== null) {
      clearTimeout(libraryRefreshTimer);
    }
    libraryRefreshTimer = window.setTimeout(() => {
      libraryRefreshTimer = null;
      void runPendingLibraryRefresh();
    }, delay);
  }

  async function runPendingLibraryRefresh(): Promise<void> {
    if (!hasPendingLibraryRefresh || !isMounted || !isPageVisible || !selectedDirectory) return;
    if (isLoading || isLibraryRefreshInProgress) {
      scheduleLibraryRefresh();
      return;
    }

    const directory = selectedDirectory;
    hasPendingLibraryRefresh = false;
    isLibraryRefreshInProgress = true;
    try {
      await scanDirectory(directory, { preserveScroll: true, silent: true });
    } finally {
      isLibraryRefreshInProgress = false;
      if (hasPendingLibraryRefresh && directory === selectedDirectory) {
        scheduleLibraryRefresh();
      }
    }
  }

  async function startLibraryDirectoryWatcher(directory: string): Promise<void> {
    stopLibraryDirectoryWatcher();
    if (!directory || !isMounted || !isTauri) return;

    const watcherGeneration = libraryWatcherGeneration;
    try {
      const { watch } = await import('@tauri-apps/plugin-fs');
      const unwatch = await watch(directory, (event) => {
        if (
          watcherGeneration !== libraryWatcherGeneration ||
          directory !== selectedDirectory ||
          (typeof event.type === 'object' && event.type !== null && 'access' in event.type)
        ) return;

        scheduleLibraryRefresh();
      }, { recursive: true, delayMs: LIBRARY_WATCH_DEBOUNCE_MS });

      if (watcherGeneration !== libraryWatcherGeneration || directory !== selectedDirectory || !isMounted) {
        unwatch();
        return;
      }
      unwatchLibraryDirectory = unwatch;
    } catch (error) {
      console.error('Failed to watch library directory:', error);
    }
  }

  async function refreshLoadedLibrary(): Promise<void> {
    if (!selectedDirectory || !isPageVisible) return;
    hasPendingLibraryRefresh = true;
    await runPendingLibraryRefresh();
  }
  
  // Generate thumbnails only for videos without cached thumbnails
  async function generateMissingThumbnails() {
    if (!isMounted || !isPageVisible || !thumbnailCacheDir) return;
    if (isGeneratingThumbnails) {
      hasPendingThumbnailGeneration = true;
      return;
    }

    isGeneratingThumbnails = true;
    hasPendingThumbnailGeneration = false;
    try {
      const videosNeedingThumbnails = videos.filter(v => !v.thumbnail);
      console.log(`Generating thumbnails for ${videosNeedingThumbnails.length} videos`);

      let nextThumbnailIndex = 0;
      const workers = Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, videosNeedingThumbnails.length) }, async () => {
        while (isMounted && isPageVisible) {
          const video = videosNeedingThumbnails[nextThumbnailIndex++];
          if (!video) break;

          const videoIndex = videos.indexOf(video);
          if (videoIndex !== -1) {
            await generateThumbnail(videoIndex, false);
          }
        }
      });

      await Promise.all(workers);

      if (videosNeedingThumbnails.length > 0) {
        saveCache();
      }
      console.log('Thumbnail generation complete');
    } finally {
      isGeneratingThumbnails = false;
      if (hasPendingThumbnailGeneration && isMounted && isPageVisible) {
        hasPendingThumbnailGeneration = false;
        setTimeout(() => generateMissingThumbnails(), 100);
      }
    }
  }
  
  // Generate thumbnail from first frame using FFmpeg via Tauri command
  async function generateThumbnail(index: number, persistCache = true) {
    if (!browser || !isMounted || !isPageVisible || index >= videos.length || videos[index].thumbnail) return;
    
    try {
      console.log(`Generating thumbnail for: ${videos[index].name}`);
      
      const thumbPath = getThumbnailPath(videos[index].path);
      console.log(`Thumbnail will be saved to: ${thumbPath}`);
      
      // @ts-ignore - Tauri API
      const { invoke } = await import('@tauri-apps/api/core');

      // A thumbnail cache rebuild should not start a second process per video when
      // duration metadata was already restored from the library cache.
      const durationPromise = videos[index].duration > 0
        ? Promise.resolve(videos[index].duration)
        : invoke('get_video_duration', { videoPath: videos[index].path }).catch((err) => {
            console.warn(`Failed to get duration for ${videos[index].name}:`, err);
            return 0;
          });
      
      // Get video duration and generate thumbnail in parallel
      const [duration, thumbnailResult] = await Promise.all([
        durationPromise,
        invoke('generate_video_thumbnail', {
          videoPath: videos[index].path,
          outputPath: thumbPath
        }).catch((err) => {
          console.error(`FFmpeg thumbnail generation failed for ${videos[index].name}:`, err);
          throw err;
        })
      ]);
      
      // Update duration if we got it
      if (duration && typeof duration === 'number') {
        videos[index].duration = duration;
        console.log(`Duration for ${videos[index].name}: ${duration.toFixed(2)}s`);
      }
      
      console.log(`Thumbnail generated successfully at: ${thumbPath}`);
      
      // Load the generated thumbnail (no need to verify - FFmpeg will have created it)
      const cachedUrl = await loadThumbnailFromCache(videos[index].path, videos[index].createdAt ?? 0);
      if (cachedUrl && isMounted && isPageVisible) {
        videos[index].thumbnail = cachedUrl;
        updateFilteredVideos();
        
        if (persistCache) {
          saveCache();
        }
        
        console.log(`Thumbnail loaded and displayed for: ${videos[index].name}`);
      } else {
        console.error(`Failed to load thumbnail URL for: ${videos[index].name}`);
      }
    } catch (error) {
      console.error(`Thumbnail generation failed for ${videos[index].name}:`, error);
    }
  }
  
  // Hover + preview 
  function handleVideoHover(videoPath: string) {
    if (hoverTimeout) clearTimeout(hoverTimeout);

    hoverTimeout = window.setTimeout(() => {
      if (!isMounted || !isPageVisible) return;
      hoveredVideo = videoPath;
      startCardPreview(videoPath);
    }, 275);
  }

  async function startCardPreview(videoPath: string) {
    const videoEl = videoPreviews[videoPath];
    if (!videoEl) return;

    try {
      // @ts-ignore - Tauri API
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const video = videos.find(item => item.path === videoPath);
      const assetUrl = `${convertFileSrc(videoPath)}?v=${video?.createdAt ?? 0}`;

      if (videoEl.src !== assetUrl) {
        videoEl.src = assetUrl;
      }

      if (hoveredVideo === videoPath) {
        const { start } = getRememberedPreviewRange(videoPath, videoEl.duration);
        if (videoEl.readyState >= videoEl.HAVE_METADATA && Number.isFinite(start) && Math.abs(videoEl.currentTime - start) > 0.25) {
          videoEl.currentTime = start;
        }
        await videoEl.play().catch(() => {}); // silent fail on quick hover leave
      }
    } catch (err) {
      console.debug('Preview soft fail (normal)', err);
    }
  }

  function handlePreviewLoadedMetadata(videoPath: string) {
    const videoEl = videoPreviews[videoPath];
    if (!videoEl) return;

    const { start } = getRememberedPreviewRange(videoPath, videoEl.duration);
    if (Number.isFinite(start) && start > 0) {
      videoEl.currentTime = start;
    }
  }

  function handlePreviewTimeUpdate(videoPath: string) {
    const videoEl = videoPreviews[videoPath];
    if (!videoEl || hoveredVideo !== videoPath) return;

    const { start, end } = getRememberedPreviewRange(videoPath, videoEl.duration);
    if (end !== null && videoEl.currentTime >= end) {
      videoEl.currentTime = start;
    }
  }

  function handleVideoLeave() {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }

    const leavingPath = hoveredVideo;
    hoveredVideo = null;

    if (leavingPath && videoPreviews[leavingPath]) {
      videoPreviews[leavingPath]?.pause();
    }
  }
  
  // Intersection Observer callback
  function handleIntersection(entries: IntersectionObserverEntry[]) {
    if (!isMounted || !isPageVisible) return;
    
    entries.forEach(entry => {
      const videoPath = entry.target.getAttribute('data-video-path');
      if (!videoPath) return;
      
      if (entry.isIntersecting) {
        visibleVideos.add(videoPath);
      } else {
        visibleVideos.delete(videoPath);
        // Stop preview if this video is no longer visible
        if (hoveredVideo === videoPath) {
          handleVideoLeave();
        }
      }
    });
  }
  
  // Throttle function to limit execution rate
  function throttle<T extends (...args: any[]) => any>(func: T, limit: number): T {
    let inThrottle: boolean;
    return function(this: any, ...args: any[]) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    } as T;
  }
  
  // Svelte action to observe video card visibility
  function observeVisibility(element: HTMLElement, videoPath: string) {
    element.setAttribute('data-video-path', videoPath);
    observer?.observe(element);
    
    return {
      destroy() {
        observer?.unobserve(element);
      }
    };
  }
  
  // Toggle video selection
  function toggleVideoSelection(videoPath: string, event?: MouseEvent) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    
    if (!browser) return;
    
    const newSelection = new Set(selectedVideos);
    if (mediaPickerMode === 'replace') {
      if (newSelection.has(videoPath)) {
        newSelection.delete(videoPath);
      } else {
        newSelection.clear();
        newSelection.add(videoPath);
      }
      selectedVideos = newSelection;
      return;
    }
    if (newSelection.has(videoPath)) {
      newSelection.delete(videoPath);
    } else {
      newSelection.add(videoPath);
    }
    selectedVideos = newSelection;
  }
  
  // Select video and navigate to trimmer - INSTANT (for single click when no selection)
  function selectVideo(videoPath: string) {
    if (!browser) return;
    
    // If in selection mode, toggle selection instead
    if (isSelectionMode) {
      toggleVideoSelection(videoPath);
      return;
    }
    
    // Otherwise, navigate immediately (original behavior)
    saveLibraryScrollPosition();
    localStorage.setItem('selectedVideoPath', videoPath);
    goto('/');
  }
  
  // Proceed to trimmer with selected videos
  async function proceedToTrimmer() {
    if (!browser || selectedVideos.size === 0) return;
    
    try {
      // Store selected video paths in localStorage
      const selectedPaths = Array.from(selectedVideos);
      localStorage.setItem('selectedVideoPaths', JSON.stringify(selectedPaths));
      localStorage.setItem('multiSelectMode', 'true');
      
      // Navigate to trimmer
      saveLibraryScrollPosition();
      goto('/');
    } catch (error) {
      console.error('Error proceeding to trimmer:', error);
      displayStatus('Failed to proceed to trimmer', 'error');
    }
  }
  
  // Clear selection
  function clearSelection() {
    selectedVideos = new Set();
  }

  function toggleVideoMenu(videoPath: string, event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    handleVideoLeave();
    openVideoMenu = openVideoMenu === videoPath ? null : videoPath;
  }

  function openDeleteConfirmation(video: VideoFile, event: MouseEvent): void {
    event.stopPropagation();
    openVideoMenu = null;
    pendingDeleteVideo = video;
  }

  async function openRenameDialog(video: VideoFile, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    openVideoMenu = null;
    pendingRenameVideo = video;
    renameValue = video.name;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function removeRememberedClipState(videoPath: string): void {
    if (!browser) return;
    const states = loadLibraryClipStates();
    delete states[videoPath];
    localStorage.setItem(LIBRARY_CLIP_STATE_KEY, JSON.stringify(states));
    refreshRememberedClipStates();
  }

  function migrateRememberedClipState(oldPath: string, newPath: string): void {
    if (!browser) return;
    const states = loadLibraryClipStates();
    if (states[oldPath]) {
      states[newPath] = states[oldPath];
      delete states[oldPath];
      localStorage.setItem(LIBRARY_CLIP_STATE_KEY, JSON.stringify(states));
      refreshRememberedClipStates();
    }
  }

  async function deleteVideo(): Promise<void> {
    if (!pendingDeleteVideo || isFileActionPending) return;
    const video = pendingDeleteVideo;
    isFileActionPending = true;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_library_video', { videoPath: video.path });
      videos = videos.filter(item => item.path !== video.path);
      selectedVideos = new Set([...selectedVideos].filter(path => path !== video.path));
      removeRememberedClipState(video.path);
      updateFilteredVideos();
      saveCache();
      pendingDeleteVideo = null;
      displayStatus(`Deleted ${video.name}`, 'success');
    } catch (error) {
      displayStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      isFileActionPending = false;
    }
  }

  async function renameVideo(): Promise<void> {
    if (!pendingRenameVideo || isFileActionPending) return;
    const video = pendingRenameVideo;
    const newName = renameValue.trim();
    if (!newName) return;
    isFileActionPending = true;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const newPath = await invoke<string>('rename_library_video', {
        videoPath: video.path,
        newName
      });
      const renamedThumbnail = await thumbnailExists(newPath)
        ? await loadThumbnailFromCache(newPath, video.createdAt ?? 0)
        : null;
      videos = videos.map(item => item.path === video.path
        ? { ...item, path: newPath, name: newName, thumbnail: renamedThumbnail }
        : item
      );
      selectedVideos = new Set([...selectedVideos].map(path => path === video.path ? newPath : path));
      migrateRememberedClipState(video.path, newPath);
      updateFilteredVideos();
      saveCache();
      pendingRenameVideo = null;
      displayStatus(`Renamed to ${newName}`, 'success');
      if (!renamedThumbnail) {
        setTimeout(() => generateMissingThumbnails(), 100);
      }
    } catch (error) {
      displayStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      isFileActionPending = false;
    }
  }

  async function openFileLocation(video: VideoFile, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    openVideoMenu = null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_library_video_location', { videoPath: video.path });
    } catch (error) {
      displayStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }
  
  // Format file size
  function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
  
  // Format duration
  function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function getRememberedPreviewRange(videoPath: string, duration = 0): { start: number; end: number | null } {
    const state = getLibraryClipState(videoPath);
    const start = Math.max(0, parseTime(state?.startTime ?? ''));
    const rememberedEnd = parseTime(state?.endTime ?? '');
    const end = rememberedEnd > start ? rememberedEnd : null;

    return {
      start: duration > 0 ? Math.min(start, duration) : start,
      end: end && duration > 0 ? Math.min(end, duration) : end
    };
  }

  function getDisplayDuration(video: VideoFile): number {
    const range = getRememberedPreviewRange(video.path, video.duration);
    return range.end !== null && range.end > range.start ? range.end - range.start : video.duration;
  }
  
  // Keyboard shortcuts
  function handleKeyDown(e: KeyboardEvent) {
    if (!isMounted) return;

    if (e.key === 'Escape') {
      openVideoMenu = null;
      pendingDeleteVideo = null;
      pendingRenameVideo = null;
      return;
    }
    
    if (e.ctrlKey && e.key === '1') {
      e.preventDefault();
    } else if (e.ctrlKey && e.key === '2') {
      e.preventDefault();
      navigateToTrimmer();
    }
  }

  function navigateToTrimmer() {
    saveLibraryScrollPosition();
    localStorage.removeItem(EDITOR_MEDIA_PICKER_MODE_KEY);
    goto('/');
  }
  
  // Handle page visibility changes - pause all activities when hidden
  function handleVisibilityChange() {
    if (!browser) return;
    
    const wasVisible = isPageVisible;
    isPageVisible = !document.hidden;
    
    console.log(`Page visibility changed: ${isPageVisible ? 'visible' : 'hidden'}`);
    
    if (!isPageVisible) {
      // Page is hidden - stop all activities immediately
      console.log('Stopping all activities - page hidden');
      
      // Stop preview
      handleVideoLeave();
      
      // Disconnect intersection observer to stop monitoring
      if (observer) {
        observer.disconnect();
      }
      
      // Clear visible videos set
      visibleVideos.clear();
      
      // Clear any pending timers
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
    } else if (wasVisible === false) {
      // Page is visible again - resume activities
      console.log('Resuming activities - page visible');
      refreshRememberedClipStates();
      
      if (observer && filteredVideos.length > 0) {
        // Reconnect observer to existing video cards
        const videoCards = document.querySelectorAll('[data-video-path]');
        videoCards.forEach(card => observer?.observe(card));
      }
      
      // Resume thumbnail generation if needed (with delay to avoid immediate CPU spike)
      if (videos.some(v => !v.thumbnail) && thumbnailCacheDir) {
        setTimeout(() => {
          if (isMounted && isPageVisible) {
            console.log('Resuming thumbnail generation');
            generateMissingThumbnails();
          }
        }, 500);
      }
      refreshLoadedLibrary();
    }
  }
  
  onMount(async () => {
    if (browser) {
      mediaPickerMode = localStorage.getItem(EDITOR_MEDIA_PICKER_MODE_KEY) === 'replace'
        ? 'replace'
        : 'add';
      isMounted = true;
      isPageVisible = !document.hidden;
      refreshRememberedClipStates();
      
      console.log('Library page mounted');
      
      document.addEventListener('keydown', handleKeyDown);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('beforeunload', handleWindowBeforeUnload);
      
      // Initialize Intersection Observer with throttled callback
      observer = new IntersectionObserver(throttle(handleIntersection, 500), {
        root: null,
        rootMargin: '100px',
        threshold: 0.01
      });
      
      // Load cached library data
      const cache = loadCache();
      if (cache && isMounted) {
        console.log('Loading cached library data:', cache.directory);
        selectedDirectory = cache.directory;
        videos = cache.videos;
        updateFilteredVideos();
        restoreLibraryScrollPosition();
        setTimeout(() => {
          if (isMounted && isPageVisible) {
            refreshLoadedLibrary();
          }
        }, 100);
        
        // Regenerate thumbnails that failed or are missing (only if page is visible)
        if (isPageVisible && thumbnailCacheDir) {
          setTimeout(() => {
            if (isMounted && isPageVisible) {
              console.log('Starting thumbnail generation from cache');
              generateMissingThumbnails();
            }
          }, 500);
        }
      }
      hasCheckedInitialLibraryCache = true;

      // Initialize thumbnail cache first
      await initThumbnailCache();
      
      // Check if running in Tauri
      try {
        // @ts-ignore - Check for Tauri API
        const { isTauri: checkTauri } = await import('@tauri-apps/api/core');
        isTauri = await checkTauri();
        console.log('Running in Tauri:', isTauri);
        if (isTauri && selectedDirectory) {
          await startLibraryDirectoryWatcher(selectedDirectory);
        }
      } catch {
        isTauri = false;
        console.log('Not running in Tauri');
      }

    }
  });
  
  onDestroy(() => {
    console.log('Library page unmounting - cleaning up resources');
    
    isMounted = false;
    isPageVisible = false;
    activeScanId++;
    stopLibraryDirectoryWatcher();
    
    if (browser) {
      if (!isWindowUnloading) {
        saveLibraryScrollPosition();
      }

      // Remove event listeners
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleWindowBeforeUnload);
      
      // Clear all timers
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      // Disconnect observer
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      
      // Completely remove video element
      if (previewVideo) {
        if (previewVideo.parentNode) {
          previewVideo.parentNode.removeChild(previewVideo);
        }
        previewVideo = null;
      }
      
      // Clear all state
      visibleVideos.clear();
      hoveredVideo = null;
      
      console.log('Library page cleanup complete');
    }
  });
</script>

<div class="h-screen w-screen flex flex-col bg-gray-900 overflow-hidden text-white">
  <!-- Header -->
  <header class="h-12 bg-gray-800/50 px-6 flex items-center justify-between shadow-xl z-10 border-b border-gray-800">
    <h1 class="font-light tracking-widest text-xl flex items-center gap-2">
      <span class="bg-clip-text bg-gradient-to-r from-gray-200 to-slate-600">Video Library</span>
    </h1>
    
    <div class="flex items-center gap-4">
      <button
        onclick={navigateToTrimmer}
        class="px-4 py-1.5 bg-slate-600/70 hover:bg-slate-500/70 rounded-lg text-sm font-medium transition-all duration-200"
      >
        {mediaPickerMode === 'replace' ? 'Cancel Change' : 'Trimmer (Ctrl+2)'}
      </button>
    </div>
  </header>
  
  <!-- Main Content -->
  <div class="flex-1 flex flex-col overflow-hidden">
    <!-- Search and Controls Bar -->
    <div class="p-4 bg-gray-800/30 border-b border-gray-700/20">
      <div class="flex gap-4 items-center">
        <button
          onclick={selectDirectory}
          class="px-4 py-2 bg-gradient-to-r from-slate-600 to-gray-700 hover:from-slate-500 hover:to-gray-600 rounded-lg text-white font-medium transition-all duration-200 shadow-md flex items-center gap-2"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          Select Folder
        </button>
        
        <div class="flex-1 relative">
          <input
            type="text"
            oninput={handleSearchInput}
            placeholder="Search videos..."
            class="w-full px-4 py-2 bg-gray-800/50 border border-gray-700/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/30"
          />
          <svg class="absolute right-3 top-2.5 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        
        {#if selectedDirectory}
          <div class="text-sm text-gray-400 tabular-nums">
            {videos.length} video{videos.length !== 1 ? 's' : ''} found{isLoading ? ' so far' : ''}
          </div>
        {/if}
      </div>
      
      {#if selectedDirectory}
        <div class="mt-2 text-xs text-gray-400">
          <span class="font-medium">Current folder:</span> {selectedDirectory}
        </div>
      {/if}
    </div>
    
    <!-- Video Grid -->
    <div
      bind:this={libraryScroller}
      bind:clientWidth={libraryViewportWidth}
      bind:clientHeight={libraryViewportHeight}
      onscroll={handleLibraryScroll}
      class="library-scrollbar flex-1 overflow-auto"
    >
      {#if !hasCheckedInitialLibraryCache}
        <div class="flex items-center justify-center h-full">
          <div class="text-center">
            <div class="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p class="text-gray-400">Loading library...</p>
          </div>
        </div>
      {:else if isLoading && isInitialScanBatchPending}
        <div class="flex items-center justify-center h-full">
          <div class="text-center">
            <div class="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p class="text-gray-400">Scanning directory...</p>
          </div>
        </div>
      {:else if !selectedDirectory}
        <div class="flex items-center justify-center h-full">
          <div class="text-center max-w-md">
            <svg class="w-24 h-24 mx-auto mb-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <h2 class="text-2xl font-light mb-2 text-slate-100">No Folder Selected</h2>
            <p class="text-slate-300 mb-6">Select a folder to browse your video library</p>
            <button
              onclick={selectDirectory}
              class="px-6 py-3 bg-gradient-to-r from-slate-600 to-gray-700 hover:from-slate-500 hover:to-gray-600 rounded-lg text-white font-medium transition-all duration-200 shadow-md"
            >
              Select Video Folder
            </button>
            <p class="text-xs text-gray-500 mt-4">Note: Folder selection only works in the desktop app</p>
          </div>
        </div>
        {:else if filteredVideos.length === 0}
        <div class="flex items-center justify-center h-full">
          <div class="text-center">
            <svg class="w-24 h-24 mx-auto mb-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <h2 class="text-2xl font-light mb-2 text-slate-100">No Videos Found</h2>
            <p class="text-slate-300">Try selecting a different folder or adjust your search</p>
          </div>
        </div>
      {:else}
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {#each filteredVideos as video (video.path)}
            <div
              use:observeVisibility={video.path}
              class="group relative bg-gray-800/30 rounded-lg border {selectedVideos.has(video.path) ? 'border-blue-500' : 'border-gray-700/30'} hover:border-blue-500/50 transition-all duration-200 cursor-pointer hover:shadow-lg hover:shadow-blue-500/10 {selectedVideos.has(video.path) ? 'ring-2 ring-blue-500/50' : ''}"
              onmouseenter={() => handleVideoHover(video.path)}
              onmouseleave={handleVideoLeave}
              onclick={() => selectVideo(video.path)}
              role="button"
              tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && selectVideo(video.path)}
            >
            <!-- Thumbnail + preview -->
            <div class="relative aspect-video overflow-hidden rounded-t-lg bg-gray-900/50">
              {#if video.thumbnail}
                <img
                  src={video.thumbnail}
                  alt={video.name}
                  class="w-full h-full object-cover transition-opacity duration-300 {hoveredVideo === video.path ? 'opacity-0' : 'opacity-100'}"
                  loading="lazy"
                />
              {:else}
                <div class="w-full h-full flex items-center justify-center">
                  <svg class="w-12 h-12 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
              {/if}

              <!-- Per-card preview video -->
              <video
                bind:this={videoPreviews[video.path]}
                class="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
                style="opacity: {hoveredVideo === video.path ? '1' : '0'};"
                muted
                playsInline
                preload="none"
                onloadedmetadata={() => handlePreviewLoadedMetadata(video.path)}
                ontimeupdate={() => handlePreviewTimeUpdate(video.path)}
              ></video>
                
                <!-- Selection Circle - Faint on hover, visible when selected -->
                <div 
                  class="absolute top-2 left-2 z-20 transition-opacity duration-200 {selectedVideos.has(video.path) ? 'opacity-100' : 'opacity-0 group-hover:opacity-30'} hover:opacity-100"
                  onclick={(e) => toggleVideoSelection(video.path, e)}
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => e.key === 'Enter' && toggleVideoSelection(video.path)}
                >
                  <div class="w-6 h-6 rounded-full border-2 {selectedVideos.has(video.path) ? 'bg-blue-500 border-blue-400' : 'bg-gray-800/50 border-gray-400'} flex items-center justify-center transition-all duration-200 hover:scale-110 shadow-lg">
                    {#if selectedVideos.has(video.path)}
                      <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                      </svg>
                    {/if}
                  </div>
                </div>  
                
                <!-- Duration Badge -->
                {#if getDisplayDuration(video) > 0}
                  <div class="absolute bottom-2 right-2 px-2 py-1 bg-black/70 rounded text-xs font-medium z-10">
                    {formatDuration(getDisplayDuration(video))}
                  </div>
                {/if}
              </div>
              
              <!-- Video Info -->
              <div class="relative flex items-center gap-2 p-3">
                <div class="min-w-0 flex-1">
                  <h3 class="mb-1 truncate text-sm font-medium text-white" title={video.name}>
                    {video.name}
                  </h3>
                  <p class="text-xs text-gray-400">
                    {formatSize(video.size)}
                  </p>
                </div>
                <button
                  type="button"
                  class="relative z-30 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-300 transition-colors hover:bg-gray-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/60"
                  aria-label={`Actions for ${video.name}`}
                  aria-expanded={openVideoMenu === video.path}
                  onclick={(event) => toggleVideoMenu(video.path, event)}
                >
                  <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="12" cy="19" r="1.8" />
                  </svg>
                </button>

                {#if openVideoMenu === video.path}
                  <div
                    class="absolute bottom-11 right-2 z-50 w-44 overflow-hidden rounded-lg border border-gray-600/60 bg-gray-800 py-1 shadow-2xl"
                    role="menu"
                    tabindex="-1"
                  >
                    <button type="button" class="w-full px-3 py-2 text-left text-sm text-gray-100 hover:bg-gray-700" role="menuitem" onclick={(event) => openRenameDialog(video, event)}>Rename</button>
                    <button type="button" class="w-full px-3 py-2 text-left text-sm text-gray-100 hover:bg-gray-700" role="menuitem" onclick={(event) => openFileLocation(video, event)}>Open file location</button>
                    <button type="button" class="w-full px-3 py-2 text-left text-sm text-red-300 hover:bg-red-950/60" role="menuitem" onclick={(event) => openDeleteConfirmation(video, event)}>Delete</button>
                  </div>
                {/if}
              </div>
              
              <!-- Hover Overlay -->
              <div class="pointer-events-none absolute inset-0 rounded-lg bg-gradient-to-t from-blue-600/20 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"></div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
  
  <!-- Selection Action Bar -->
  {#if isSelectionMode}
    <div class="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-600/40 bg-gradient-to-r from-slate-800/95 to-gray-900/95 p-4 shadow-2xl shadow-black/40 backdrop-blur-md animate-fadeIn">
      <div class="max-w-7xl mx-auto flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="font-medium text-slate-100">
            {selectedVideos.size} video{selectedVideos.size !== 1 ? 's' : ''} selected
          </div>
          <button
            onclick={clearSelection}
            class="rounded-lg border border-slate-500/30 bg-slate-700/60 px-4 py-2 text-sm font-medium text-slate-200 transition-all duration-200 hover:border-slate-400/40 hover:bg-slate-600/70 hover:text-white"
          >
            Clear Selection
          </button>
        </div>
        <button
          onclick={proceedToTrimmer}
          class="flex items-center gap-2 rounded-lg border border-slate-400/30 bg-gradient-to-r from-slate-200 to-gray-300 px-6 py-3 font-semibold text-slate-800 shadow-lg transition-all duration-200 hover:scale-105 hover:from-white hover:to-slate-200"
        >
          <span>{mediaPickerMode === 'replace' ? 'Change Active Track' : 'Add to Tracks'}</span>
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  {/if}

  {#if pendingDeleteVideo}
    <div class="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" class="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm" aria-label="Close delete confirmation" disabled={isFileActionPending} onclick={() => pendingDeleteVideo = null}></button>
      <div class="relative w-full max-w-md rounded-xl border border-gray-600/60 bg-gray-800 p-5 shadow-2xl" role="alertdialog" aria-modal="true" aria-labelledby="delete-video-title" tabindex="-1">
        <h2 id="delete-video-title" class="text-lg font-semibold text-white">Delete {pendingDeleteVideo.name}?</h2>
        <p class="mt-2 text-sm leading-6 text-gray-300">This permanently deletes the video file from your computer. This action cannot be undone.</p>
        <div class="mt-5 flex justify-end gap-3">
          <button type="button" class="rounded-lg px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50" disabled={isFileActionPending} onclick={() => pendingDeleteVideo = null}>Cancel</button>
          <button type="button" class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50" disabled={isFileActionPending} onclick={deleteVideo}>{isFileActionPending ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if pendingRenameVideo}
    <div class="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" class="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm" aria-label="Close rename dialog" disabled={isFileActionPending} onclick={() => pendingRenameVideo = null}></button>
      <form class="relative w-full max-w-md rounded-xl border border-gray-600/60 bg-gray-800 p-5 shadow-2xl" onsubmit={(event) => { event.preventDefault(); renameVideo(); }}>
        <h2 class="text-lg font-semibold text-white">Rename video</h2>
        <label for="video-file-name" class="mt-4 block text-sm text-gray-300">File name</label>
        <input id="video-file-name" bind:this={renameInput} class="mt-2 w-full rounded-lg border border-gray-600 bg-gray-900/70 px-3 py-2 text-white focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30" bind:value={renameValue} disabled={isFileActionPending} />
        <p class="mt-2 text-xs text-gray-400">Keep the existing video file extension.</p>
        <div class="mt-5 flex justify-end gap-3">
          <button type="button" class="rounded-lg px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50" disabled={isFileActionPending} onclick={() => pendingRenameVideo = null}>Cancel</button>
          <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={isFileActionPending || !renameValue.trim()}>{isFileActionPending ? 'Renaming…' : 'Rename'}</button>
        </div>
      </form>
    </div>
  {/if}
  
  <!-- Status Notification -->
  {#if showStatusNotification}
    <div class="fixed bottom-4 left-1/2 transform -translate-x-1/2 p-4 rounded-lg font-medium shadow-xl z-50 text-sm max-w-md {statusNotificationType === 'success' ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white' : statusNotificationType === 'error' ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white' : 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white'} backdrop-blur-sm border {statusNotificationType === 'success' ? 'border-green-400/30' : statusNotificationType === 'error' ? 'border-red-400/30' : 'border-blue-400/30'} animate-fadeIn {isSelectionMode ? 'bottom-20' : ''}">
      {statusNotificationMessage}
    </div>
  {/if}
</div>

<style>
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .animate-spin {
    animation: spin 1s linear infinite;
  }
  
  .animate-fadeIn {
    animation: fadeIn 0.3s ease-out forwards;
  }

  .library-scrollbar {
    scrollbar-color: #475569 #111827;
    scrollbar-width: thin;
  }

  .library-scrollbar::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  .library-scrollbar::-webkit-scrollbar-track {
    background: #111827;
  }

  .library-scrollbar::-webkit-scrollbar-thumb {
    background: #475569;
    border: 2px solid #111827;
    border-radius: 9999px;
  }

  .library-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #64748b;
  }

  .library-scrollbar::-webkit-scrollbar-corner {
    background: #111827;
  }
</style>
