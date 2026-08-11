<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import FileDropOverlay from '$lib/components/editor/FileDropOverlay.svelte';
  import LoadingOverlay from '$lib/components/editor/LoadingOverlay.svelte';
  import OutputOptionsModal from '$lib/components/editor/OutputOptionsModal.svelte';
  import Timeline from '$lib/components/editor/Timeline.svelte';
  import TrackList from '$lib/components/editor/TrackList.svelte';
  import TrimPanel from '$lib/components/editor/TrimPanel.svelte';
  import UploadQueue from '$lib/components/editor/UploadQueue.svelte';
  import VideoPreview from '$lib/components/editor/VideoPreview.svelte';
  import StatusToast from '$lib/components/editor/StatusToast.svelte';
  import CompressionPresetModal from '$lib/components/settings/CompressionPresetModal.svelte';
  import SettingsDropdown from '$lib/components/settings/SettingsDropdown.svelte';
  import type { CompressionPreset, UploadQueueItem, VideoTrack } from '$lib/types/editor';
  import {
    createUploadQueueItem,
    findReusableUploadQueueItem,
    getUploadQueueFileName
  } from '$lib/stores/useUploadQueue';
  import {
    isVideoPath,
    loadLibraryClipState,
    saveLibraryClipState
  } from '$lib/stores/useLibraryClipState';
  import { createVideoSourceManager } from '$lib/stores/useVideoSource';
  import {
    EDITOR_MEDIA_PICKER_MODE_KEY,
    restoreEditorSession,
    saveEditorSession,
    type EditorMediaPickerMode
  } from '$lib/stores/useEditorSession';
  import { formatElapsedTime, formatTime, parseTime } from '$lib/utils/time';
  import { animateProgressValue } from '$lib/utils/progressAnimation';
  import { calculateExpectedOutputSize } from '$lib/utils/estimatedOutputSize';
  import { API_BASE, apiFetch, getBackendToken } from '$lib/backendApi';
  import {
    createAdaptiveTimelineScrubConfig,
    createTimelineScrubThrottle,
    preciseVideoSeek,
    resetTimelineScrubThrottle,
    timeFromTimelineClientX,
    trySmoothVideoSeek
  } from '$lib/utils/timelineScrub';
  import { handleEditorKeybind } from '$lib/utils/editorKeybinds';
  import uploadLimits from '../../../upload-limits.json';
   
  const fetch = apiFetch;
  const OUTPUT_DIRECTORY_KEY = 'trimmerOutputDirectory';
  const GENERATE_OUTPUT_FILENAME_KEY = 'trimmerGenerateOutputFilename';
  const HARDWARE_ACCELERATION_KEY = 'trimmerHardwareAcceleration';
  const POPUP_NOTIFICATIONS_KEY = 'trimmerPopupNotifications';
  const HIDDEN_COMPRESSION_PRESETS_KEY = 'trimmerHiddenCompressionPresetIds';
  const CHANGE_VIDEO_SOURCE_KEY = 'trimmerPreferredChangeVideoSource';
  const LIBRARY_SCROLL_TOP_KEY = 'video_library_scroll_top';
  const MAX_UPLOAD_BYTES =
    typeof uploadLimits.maxUploadBytes === 'number' && Number.isFinite(uploadLimits.maxUploadBytes)
      ? uploadLimits.maxUploadBytes
      : null;
  type DisplayCompressionPreset = CompressionPreset & { hidden?: boolean };
  type ChangeVideoSource = 'file' | 'library';
  type CompletedOutput = {
    outputSize: string;
    outputPath: string;
    filename: string;
    timeTaken: string;
    preset: string;
  };

  // Core state 
  let isEditorMounted = false;
  let videoFile = $state<File | null>(null);
  let serverOnline = $state(false);
  let videoPlayer = $state<HTMLVideoElement | null>(null);
  let videoPlayerReady = $derived(!!videoPlayer);

  // Time-related state
  let startTime = $state("00:00:00.000");
  let endTime = $state("00:00:00.000");
  let currentTime = $state(0);
  let duration = $state(0);

  // Derived time values
  let totalDuration = $derived(formatTime(duration));
  let trimDuration = $derived(formatTime(Math.max(0, parseTime(endTime) - parseTime(startTime))));
  let startTimeSeconds = $derived(parseTime(startTime));
  let endTimeSeconds = $derived(parseTime(endTime));
  let startPercent = $derived(duration > 0 ? (startTimeSeconds / duration) * 100 : 0);
  let endPercent = $derived(duration > 0 ? (endTimeSeconds / duration) * 100 : 100);
  let trimPercent = $derived(endPercent - startPercent);

  // UI state
  let statusMessage = $state("");
  let statusType = $state("");
  let showStatus = $state(false);
  let popupNotificationsEnabled = $state(false);
  let showLoadingOverlay = $state(false);
  let loadingMessage = $state("Uploading video...");
  let loadingTitle = $state("Processing Video");
  let serverStatusMessage = $state("Checking server connection...");
  let serverStatusClass = $state("server-status");
  let useSpinner = $state(false);
  let progressPercent = $state(0);
  let isPlaying = $state(false);
  let volume = $state(1);
  let showVolume = $state(false);
  let isFullscreen = $state(false);



  /** Below this width, track/trim sidebars are overlays; the video row uses the full width. */
  const LAYOUT_SIDEBARS_INFLOW_MIN_PX = 1200;
  let windowInnerWidth = $state(2000);
  let showTracksOverlay = $state(false);
  let showTrimOverlay = $state(false);
  let showChangeVideoMenu = $state(false);
  let preferredChangeVideoSource = $state<ChangeVideoSource>('file');
  let sidebarsInMainRow = $derived(
    !browser ? true : windowInnerWidth >= LAYOUT_SIDEBARS_INFLOW_MIN_PX
  );

  function closeSidebarOverlays(): void {
    showTracksOverlay = false;
    showTrimOverlay = false;
  }

  function syncLayoutFromWindow(): void {
    if (!browser) return;
    windowInnerWidth = window.innerWidth;
    if (window.innerWidth >= LAYOUT_SIDEBARS_INFLOW_MIN_PX) {
      closeSidebarOverlays();
    }
  }

  $effect(() => {
    if (!controlsEnabled) {
      closeSidebarOverlays();
    }
  });

  let isUserSeeking = $state(false);
  let seekTimeout = $state(0);
  let playFromStartRequest = 0;

  // Timeline interaction state
  let isDraggingStart = $state(false);
  let isDraggingEnd = $state(false);
  let isTimelinePlayheadScrubbing = $state(false);
  let scrubPointerTime = $state(0); 
  /**
   * When the user releases the timeline, keep the UI locked to their intended
   * target until the video element has actually landed there (prevents the
   * visible "jump back" to a stale/buffered frame).
   */
  let pendingTimelineUiTime = $state<number | null>(null);
  /** Throttle state for video seeks (not reactive — avoids extra work per frame). */
  let playheadScrubThrottle = createTimelineScrubThrottle();
  let trimScrubThrottle = createTimelineScrubThrottle();
  let shouldStopPlaybackAtTrimEnd = false;

  /** Playhead / timeline UI time: follows pointer while scrubbing or trim-dragging; else `currentTime`. */
  let timelineUiTime = $derived.by(() => {
    if (isTimelinePlayheadScrubbing) return scrubPointerTime;
    if (pendingTimelineUiTime !== null) return pendingTimelineUiTime;
    if (isDraggingStart) return startTimeSeconds;
    if (isDraggingEnd) return endTimeSeconds;
    return currentTime;
  });
  let timelineUiPercent = $derived(duration > 0 ? (timelineUiTime / duration) * 100 : 0);
  let timelineScrubConfig = $derived.by(() => {
    const activeTrack = tracks.find((track) => track.id === activeTrackId);
    const fileSizeBytes = activeTrack?.videoFile?.size ?? activeTrack?.fileSizeBytes;
    return createAdaptiveTimelineScrubConfig(fileSizeBytes, duration);
  });

  // Upload state
  let isUploading = $state(false);
  let uploadProgress = $state(0);
  let uploadedVideoId = $state<string | null>(null);
  let uploadController = $state<AbortController | null>(null);

  // Upload queue state
  let uploadQueue = $state<UploadQueueItem[]>([]);
  let isProcessingQueue = $state(false);
  let shouldDiscardEditorSessionOnLeave = false;

  // Processing state
  let currentJobId = $state<string | null>(null);
  let isProcessing = $state(false);
  let completedOutput = $state<CompletedOutput | null>(null);
  let showOutputOptions = $state(false);
  let outputOptionsError = $state('');

  // Compression state
  let selectedCompressionMode = $state('original');
  let compressionModes = $state<DisplayCompressionPreset[]>([]);
  let expectedOutputSize = $state('');
  let outputDirectory = $state('');
  let outputFilename = $state('');
  let generateOutputFilename = $state(false);
  let hardwareAccelerationEnabled = $state(false);
  let hiddenCompressionPresetIds = $state<string[]>([]);
  let compressionPresetModalOpen = $state(false);
  let editingCompressionPreset = $state<CompressionPreset | null>(null);
  let compressionPresetSaving = $state(false);
  let compressionPresetError = $state('');

  function applyCompressionModes(modes: CompressionPreset[], defaultMode?: string): void {
    compressionModes = modes.map((mode) => ({
      ...mode,
      hidden: hiddenCompressionPresetIds.includes(mode.id)
    }));
    const visibleModes = compressionModes.filter((mode) => !mode.hidden);
    if (!visibleModes.some((mode) => mode.id === selectedCompressionMode)) {
      selectedCompressionMode = defaultMode && visibleModes.some((mode) => mode.id === defaultMode)
        ? defaultMode
        : visibleModes[0]?.id ?? selectedCompressionMode;
    }
  }

  function runChangeVideoSource(source: ChangeVideoSource): void {
    showChangeVideoMenu = false;
    if (source === 'library') {
      openLibraryPicker('replace');
    } else {
      void changeVideoFromFileManager();
    }
  }

  function setPreferredChangeVideoSource(source: ChangeVideoSource): void {
    preferredChangeVideoSource = source;
    localStorage.setItem(CHANGE_VIDEO_SOURCE_KEY, source);
  }

  // Computed values using derived
  let controlsEnabled = $derived.by(() => {
    if (!activeTrackId) return false;
    const activeTrack = tracks.find(t => t.id === activeTrackId);
    return !!(activeTrack && (activeTrack.videoFile || activeTrack.filePath));
  });
  let downloadEnabled = $derived.by(() => {
    if (!serverOnline || !activeTrackId) return false;
    const activeTrack = tracks.find(t => t.id === activeTrackId);
    return !!(activeTrack && activeTrack.uploadedVideoId !== null);
  });
  
  // Helper to get video file name from active track
  let activeVideoName = $derived.by(() => {
    if (!activeTrackId) return 'No video';
    const activeTrack = tracks.find(t => t.id === activeTrackId);
    if (!activeTrack) return 'No video';
    if (activeTrack.videoFile) return activeTrack.videoFile.name;
    if (activeTrack.filePath) return activeTrack.filePath.split(/[\\/]/).pop() || 'video.mp4';
    return 'No video';
  });
  let circularProgressOffset = $derived(219.9 - (Math.min(100, progressPercent) / 100) * 219.9);

  // Additional state for intervals
  let serverCheckInterval = $state<ReturnType<typeof setInterval> | undefined>(undefined);
  let previewInterval = $state<ReturnType<typeof setInterval> | undefined>(undefined);
  let unlistenTauriFileDrop: (() => void) | null = null;

  // Drag and drop state
  let isDragOver = $state(false);
  let dragCounter = $state(0);

  // Convert remaining $: statements to $derived
  let expectedSizeString = $state('');
  
  // Update expected size calculation
  $effect(() => {
    expectedSizeString = calculateExpectedOutputSize({
      tracks,
      activeTrackId,
      startTimeSeconds,
      endTimeSeconds,
      duration,
      selectedCompressionMode,
      compressionPresets: compressionModes
    });
  });
  

  // Update expected output size when string changes
  $effect(() => {
    expectedOutputSize = expectedSizeString;
  });

  // Video player binding effect
  $effect(() => {
    if (!videoPlayerReady) return;
    const player = videoPlayer!;

    // Handle video element binding
    const bindVideo = (element: HTMLVideoElement) => {
      videoPlayer = element;
      player.volume = volume;
    };

    return () => {
      videoPlayer = null;
    };
  });

  // State to track the currently loaded video file (can be File or filePath string)
  let currentlyLoadedVideoFile = $state<File | string | null>(null);
  let currentlyLoadedTrackId = $state<string | null>(null);
  let activeVideoLoadToken = 0;
  let isVideoTransitioning = $state(false);
  let transitionFrame = $state<string | null>(null);
  let isRestoringLibrarySelection = $state(true);
  const videoSource = createVideoSourceManager();
  let preloadedTrackSources = $state<Record<string, string>>({});

  function videoUrlAtStartTime(url: string, startSeconds: number): string {
    if (!Number.isFinite(startSeconds) || startSeconds <= 0.05) return url;

    const baseUrl = url.split('#')[0];
    return `${baseUrl}#t=${startSeconds.toFixed(3)}`;
  }

  function preserveCurrentVideoFrame(player: HTMLVideoElement): void {
    if (player.readyState < player.HAVE_CURRENT_DATA || !player.videoWidth || !player.videoHeight) {
      transitionFrame = null;
      return;
    }

    try {
      const longestSide = Math.max(player.videoWidth, player.videoHeight);
      const scale = Math.min(1, 1280 / longestSide);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(player.videoWidth * scale);
      canvas.height = Math.round(player.videoHeight * scale);
      canvas.getContext('2d')?.drawImage(player, 0, 0, canvas.width, canvas.height);
      transitionFrame = canvas.toDataURL('image/jpeg', 0.85);
    } catch (error) {
      transitionFrame = null;
      console.debug('Could not preserve video frame during track switch:', error);
    }
  }

  function revealLoadedVideo(loadToken: number, player: HTMLVideoElement): void {
    requestAnimationFrame(() => {
      if (loadToken !== activeVideoLoadToken || videoPlayer !== player) return;
      isVideoTransitioning = false;
      transitionFrame = null;
    });
  }

  // Effect to handle video loading when videoPlayer becomes ready or track changes
  $effect(() => {
    if (!videoPlayerReady || !activeTrackId) return;
    
    const player = videoPlayer!;
    const track = tracks.find(t => t.id === activeTrackId);  
    if (!track) return;

    const source = track.filePath ?? track.videoFile;
    if (!source) return;

    const needsChange = source !== currentlyLoadedVideoFile || track.id !== currentlyLoadedTrackId;
    if (!needsChange) {
      // same file → just seek / update duration if needed
      if (track.duration <= 0 && player.duration > 0) {
        track.duration = player.duration;
      }
      return;
    }

    const loadToken = ++activeVideoLoadToken;
    const sourceForThisLoad = source;
    const trackStart = parseTime(track.startTime);
    preserveCurrentVideoFrame(player);
    isVideoTransitioning = true;
    currentTime = trackStart;
    if (track.duration > 0) {
      duration = track.duration;
    }
    pendingTimelineUiTime = null;
    isTimelinePlayheadScrubbing = false;
    isUserSeeking = false;

    (async () => {
      try {
        const url = await videoSource.getVideoSourceUrl(track);
        if (!url || loadToken !== activeVideoLoadToken || activeTrackId !== track.id || videoPlayer !== player) {
          return;
        }
        const playbackUrl = videoUrlAtStartTime(url, trackStart);

        const handleLoadedMetadata = () => {
          if (loadToken !== activeVideoLoadToken || activeTrackId !== track.id || videoPlayer !== player) {
            return;
          }

          duration = player.duration;
          track.duration = duration;
          if (!track.endTimeManuallySet) {
            endTime = formatTime(duration);
            track.endTime = endTime;
            saveTrackState();
          }

          const targetTime = Math.min(parseTime(track.startTime), Math.max(0, player.duration - 0.01));
          const revealAtStart = () => {
            if (loadToken !== activeVideoLoadToken || activeTrackId !== track.id || videoPlayer !== player) {
              return;
            }
            currentTime = targetTime;
            revealLoadedVideo(loadToken, player);
          };

          if (Math.abs(player.currentTime - targetTime) <= 0.05) {
            revealAtStart();
          } else {
            player.addEventListener('seeked', revealAtStart, { once: true });
            player.currentTime = targetTime;
          }
        };

        player.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
        if (player.src !== playbackUrl) {
          player.src = playbackUrl;
        } else if (player.readyState >= player.HAVE_METADATA) {
          player.removeEventListener('loadedmetadata', handleLoadedMetadata);
          handleLoadedMetadata();
        }

        currentlyLoadedVideoFile = sourceForThisLoad;
        currentlyLoadedTrackId = track.id;

        // Update track's uploadedVideoId if needed
        if (!track.uploadedVideoId && uploadedVideoId) {
          track.uploadedVideoId = uploadedVideoId;
        }
      } catch (error) {
        if (loadToken !== activeVideoLoadToken || activeTrackId !== track.id) return;
        isVideoTransitioning = false;
        transitionFrame = null;
        console.error('Failed to load video source:', error);
        displayStatus('Failed to load video from library', 'error');
      }
    })();
  });

  $effect(() => {
    if (!browser || tracks.length === 0) return;

    const preloadToken = activeVideoLoadToken;
    const candidates = tracks.filter((track) => track.id !== activeTrackId && (track.videoFile || track.filePath));

    (async () => {
      const nextSources: Record<string, string> = {};
      await Promise.all(
        candidates.map(async (track) => {
          const url = await videoSource.getVideoSourceUrl(track);
          if (url) {
            nextSources[track.id] = videoUrlAtStartTime(url, parseTime(track.startTime));
          }
        })
      );

      if (preloadToken === activeVideoLoadToken && isEditorMounted) {
        preloadedTrackSources = nextSources;
      }
    })();
  });

  function smoothTimelineSeek(
    player: HTMLVideoElement,
    desiredUiTime: number,
    throttle: ReturnType<typeof createTimelineScrubThrottle>
  ): void {
    trySmoothVideoSeek(player, desiredUiTime, duration, throttle, {
      setUserSeeking: (seeking) => {
        isUserSeeking = seeking;
      },
      config: timelineScrubConfig
    });
  }

  function preciseTimelineSeek(player: HTMLVideoElement, time: number, onSettled?: () => void): void {
    preciseVideoSeek(player, time, duration, {
      setUserSeeking: (seeking) => {
        isUserSeeking = seeking;
      },
      setCurrentTime: (time) => {
        currentTime = time;
      },
      getSeekTimeout: () => seekTimeout,
      setSeekTimeout: (timeout) => {
        seekTimeout = timeout;
      },
      onSettled
    });
  }

  function handlePlayerTimeUpdate(player: HTMLVideoElement): void {
    // While the user is manipulating the timeline or we're in the middle of a seek,
    // do not let playback-driven events overwrite the UI position.
    if (
      isTimelinePlayheadScrubbing ||
      isDraggingStart ||
      isDraggingEnd ||
      isUserSeeking ||
      player.seeking
    ) {
      isPlaying = !player.paused;
      return;
    }

    currentTime = player.currentTime;
    isPlaying = !player.paused;

    // Normal playback follows the selected trim range. Seeking remains unrestricted,
    // so the playhead can still be dragged before the start or after the end marker.
    if (
      shouldStopPlaybackAtTrimEnd &&
      !player.paused &&
      Number.isFinite(endTimeSeconds) &&
      endTimeSeconds > startTimeSeconds &&
      currentTime >= endTimeSeconds
    ) {
      player.pause();
      if (Math.abs(player.currentTime - endTimeSeconds) > 0.01) {
        player.currentTime = endTimeSeconds;
      }
      currentTime = endTimeSeconds;
      isPlaying = false;
    }

    // If we were "latched" to a pending UI time, clear it once the player has landed.
    if (pendingTimelineUiTime !== null && Math.abs(currentTime - pendingTimelineUiTime) <= 0.05) {
      pendingTimelineUiTime = null;
    }

  }

  function handleTimelinePlayheadMouseDown(event: MouseEvent): void {
    if (!videoPlayerReady || duration === 0 || isDraggingStart || isDraggingEnd) return;
    event.preventDefault();
    const timeline = event.currentTarget as HTMLElement;
    const rect = timeline.getBoundingClientRect();
    const t = timeFromTimelineClientX(event.clientX, rect, duration);
    isTimelinePlayheadScrubbing = true;
    scrubPointerTime = t;
    pendingTimelineUiTime = null;
    resetTimelineScrubThrottle(playheadScrubThrottle);
    safeVideoOperation((player) => {
      smoothTimelineSeek(player, t, playheadScrubThrottle);
    });
  }

  // Track management state
  let tracks = $state<VideoTrack[]>([]);
  
  let activeTrackId = $state<string | null>(null);

  // Add new state for drag and drop (mouse-based for Tauri WebView2 compatibility)
  let draggedTrackId = $state<string | null>(null);
  let draggedOverTrackId = $state<string | null>(null);
  let isDraggingTrack = $state(false);
  let dragStartY = $state(0);
  let draggedElement = $state<HTMLElement | null>(null);

  // Track management functions
  async function addTrack() {
    // Defer loading the file chooser until needed
    await new Promise(resolve => setTimeout(resolve, 0));

    await chooseVideoFiles('addTrackFileInput', 'add');
  }

  async function changeVideoFromFileManager(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    await chooseVideoFiles('newVideoFile', 'replace');
  }

  async function chooseVideoFiles(
    fallbackInputId: string,
    mode: EditorMediaPickerMode = 'add'
  ): Promise<void> {
    if (!browser) return;

    try {
      const { isTauri } = await import('@tauri-apps/api/core');
      if (await isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core');
        const paths = await invoke<string[]>('pick_video_files', {
          multiple: mode === 'add',
          title: mode === 'replace' ? 'Change Active Track Video' : 'Add Video Tracks'
        });
        const videoPaths = paths.filter(isVideoPath);

        if (paths.length > 0 && videoPaths.length === 0) {
          displayStatus('Please select valid video files only.', 'error');
          return;
        }

        if (videoPaths.length > 0) {
          if (mode === 'replace') {
            await replaceActiveTrackFromPath(videoPaths[0]);
          } else {
            await loadMultipleVideosFromPaths(videoPaths);
          }
        }
        return;
      }
    } catch (error) {
      console.debug('Native video picker unavailable, falling back to file input:', error);
    }

    const fileInput = document.getElementById(fallbackInputId) as HTMLInputElement | null;
    fileInput?.click();
  }

  function removeTrack(trackId: string) {
    if (activeTrackId === trackId) {
      saveTrackState();
    }
    tracks = tracks.filter(track => track.id !== trackId);
    if (activeTrackId === trackId) {
      activeTrackId = tracks[0]?.id || null;
    }
  }

  // Mouse-based drag handlers (compatible with Tauri WebView2)
  function handleTrackMouseDown(trackId: string, event: MouseEvent) {
    // Only start drag on the drag handle (the icon)
    const target = event.target as HTMLElement;
    if (!target.closest('.drag-handle')) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    isDraggingTrack = true;
    draggedTrackId = trackId;
    dragStartY = event.clientY;
    draggedElement = (event.currentTarget as HTMLElement);
    
    if (draggedElement) {
      draggedElement.classList.add('dragging');
    }
    
    // Add global mouse event listeners
    document.addEventListener('mousemove', handleTrackMouseMove);
    document.addEventListener('mouseup', handleTrackMouseUp);
  }

  function handleTrackMouseMove(event: MouseEvent) {
    if (!isDraggingTrack || !draggedTrackId) return;
    
    event.preventDefault();
    
    // Find which track we're hovering over
    const trackElements = document.querySelectorAll('.track-item');
    let hoveredTrackId: string | null = null;
    
    trackElements.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY <= rect.bottom) {
        hoveredTrackId = el.getAttribute('data-track-id');
      }
    });
    
    // Update drag-over state
    if (hoveredTrackId && hoveredTrackId !== draggedTrackId) {
      draggedOverTrackId = hoveredTrackId;
      
      // Add visual feedback
      trackElements.forEach((el) => {
        if (el.getAttribute('data-track-id') === hoveredTrackId) {
          el.classList.add('drag-over');
        } else {
          el.classList.remove('drag-over');
        }
      });
    } else {
      draggedOverTrackId = null;
      trackElements.forEach((el) => el.classList.remove('drag-over'));
    }
  }

  function handleTrackMouseUp(event: MouseEvent) {
    if (!isDraggingTrack) return;
    
    event.preventDefault();
    
    // Perform the reorder if we have a valid drop target
    if (draggedTrackId && draggedOverTrackId && draggedTrackId !== draggedOverTrackId) {
      const draggedIndex = tracks.findIndex(t => t.id === draggedTrackId);
      const dropIndex = tracks.findIndex(t => t.id === draggedOverTrackId);
      
      if (draggedIndex !== -1 && dropIndex !== -1) {
        const newTracks = [...tracks];
        const [draggedTrack] = newTracks.splice(draggedIndex, 1);
        newTracks.splice(dropIndex, 0, draggedTrack);
        tracks = newTracks;
      }
    }
    
    // Clean up
    isDraggingTrack = false;
    draggedTrackId = null;
    draggedOverTrackId = null;
    draggedElement = null;
    
    // Remove all drag classes
    const trackElements = document.querySelectorAll('.track-item');
    trackElements.forEach(el => {
      el.classList.remove('dragging', 'drag-over');
    });
    
    // Remove global listeners
    document.removeEventListener('mousemove', handleTrackMouseMove);
    document.removeEventListener('mouseup', handleTrackMouseUp);
  }

  function setActiveTrack(trackId: string) {
    playFromStartRequest++;

    saveTrackState();
    
    activeTrackId = trackId;
    const track = tracks.find(t => t.id === trackId);
    if (track) {
      // Always update these values - the video loading effect will handle the rest
      videoFile = track.videoFile; // May be null for library videos (filePath is used instead)
      startTime = track.startTime;
      
      // Always use the track's end time if it was manually set
      if (track.endTimeManuallySet) {
        endTime = track.endTime;
      } else {
        // Only update end time if it wasn't manually set
        endTime = track.endTime;
      }
      
      volume = track.volume;
      selectedCompressionMode = track.compressionMode;
    }
  }

  // Add a function to save track state when making changes
  function saveTrackState() {
    if (activeTrackId) {
      const trackIndex = tracks.findIndex(t => t.id === activeTrackId);
      if (trackIndex !== -1) {
        tracks[trackIndex] = {
          ...tracks[trackIndex],
          startTime,
          endTime,
          volume,
          compressionMode: selectedCompressionMode,
          endTimeManuallySet: tracks[trackIndex].endTimeManuallySet // Preserve the flag
        };
        const track = tracks[trackIndex];
        if (track.filePath) {
          saveLibraryClipState(track.filePath, {
            startTime: track.startTime,
            endTime: track.endTime,
            compressionMode: track.compressionMode,
            volume: track.volume,
            endTimeManuallySet: track.endTimeManuallySet
          });
        }
      }
    }
  }

  function setCompressionMode(mode: string): void {
    selectedCompressionMode = mode;
    saveTrackState();
  }

  function handleStartTimeInput(): void {
    updateTrimDuration();
    saveTrackState();
  }

  function markActiveTrackEndTimeManual(): void {
    if (!activeTrackId) return;
    const trackIndex = tracks.findIndex(t => t.id === activeTrackId);
    if (trackIndex !== -1) {
      tracks[trackIndex].endTimeManuallySet = true;
    }
  }

  function handleEndTimeInput(): void {
    updateTrimDuration();
    markActiveTrackEndTimeManual();
    saveTrackState();
  }

  function navigateToLibrary(): void {
    shouldDiscardEditorSessionOnLeave = true;
    persistEditorStateBeforeLeave();
    localStorage.setItem(EDITOR_MEDIA_PICKER_MODE_KEY, 'add');
    goto('/library');
  }

  function openLibraryPicker(mode: EditorMediaPickerMode): void {
    if (!browser) return;
    saveTrackState();
    saveEditorSession(tracks, activeTrackId, uploadQueue);
    localStorage.setItem(EDITOR_MEDIA_PICKER_MODE_KEY, mode);
    goto('/library');
  }

  function persistEditorStateBeforeLeave(): void {
    saveTrackState();
    if (shouldDiscardEditorSessionOnLeave) {
      saveEditorSession([], null, []);
    } else {
      saveEditorSession(tracks, activeTrackId, uploadQueue);
    }
  }

  function handleEditorBeforeUnload(): void {
    persistEditorStateBeforeLeave();
    sessionStorage.removeItem(LIBRARY_SCROLL_TOP_KEY);
  }

  function handlePageShow(event: Event): void {
    if ((event as PageTransitionEvent).persisted) {
      checkServerConnection();
    }
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      checkServerConnection();
    }
  }

  // Drag and drop handlers for file upload
  function handleDragEnter(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    dragCounter++;
    if (event.dataTransfer?.types.includes('Files')) {
      isDragOver = true;
    }
  }

  function handleDragLeaveFile(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    dragCounter--;
    if (dragCounter === 0) {
      isDragOver = false;
    }
  }

  function handleDragOverFile(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  async function handleFileDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    isDragOver = false;
    dragCounter = 0;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // Filter video files
    const videoFiles = Array.from(files).filter(file => 
      file.type.startsWith('video/')
    );

    if (videoFiles.length === 0) {
      displayStatus('Please drop valid video files only.', 'error');
      return;
    }

    // Handle multiple files
    for (const file of videoFiles) {
      await handleSingleFileUpload(file);
    }
  }

  async function handleDroppedFilePaths(paths: string[]): Promise<void> {
    const videoPaths = paths.filter(isVideoPath);

    if (videoPaths.length === 0) {
      displayStatus('Please drop valid video files only.', 'error');
      return;
    }

    await loadMultipleVideosFromPaths(videoPaths);
  }

  // Extract single file upload logic
  async function handleSingleFileUpload(file: File): Promise<void> {
    if (!browser) return;

    if (MAX_UPLOAD_BYTES !== null && file.size > MAX_UPLOAD_BYTES) {
      displayStatus(`File "${file.name}" is too large.`, 'error');
      return;
    }

    // Check if this exact file already exists in tracks
    const existingTrack = tracks.find(t => 
      t.videoFile && 
      t.videoFile.name === file.name && 
      t.videoFile.size === file.size
    );
    
    if (existingTrack) {
      displayStatus(`Video "${file.name}" is already loaded`, 'info');
      setActiveTrack(existingTrack.id);
      return;
    }

          // Create new track for each file
          const newTrack = {
            id: crypto.randomUUID(),
            videoFile: file,
            filePath: null, // No filePath for trimmer uploads
            fileSizeBytes: file.size,
            startTime: "00:00:00.000",
            endTime: "00:00:00.000",
            offset: 0,
            volume: 1,
            compressionMode: selectedCompressionMode,
            uploadedVideoId: null,
            endTimeManuallySet: false,
            selected: false,
            duration: 0
          };

    tracks = [...tracks, newTrack];

    // If this is the first track or no active track, set it as active
    if (!activeTrackId || tracks.length === 1) {
      setActiveTrack(newTrack.id);
    }

    displayStatus(`Video "${file.name}" added to queue`, 'success');
    
    // Add to upload queue instead of uploading directly
    addToUploadQueue(file, newTrack.id);
  }

  function replaceActiveTrack(newTrack: VideoTrack): boolean {
    if (!activeTrackId) {
      displayStatus('Select a track before changing its video.', 'error');
      return false;
    }

    saveTrackState();
    const trackIndex = tracks.findIndex(track => track.id === activeTrackId);
    if (trackIndex === -1) return false;

    const previousTrack = tracks[trackIndex];
    const replacement: VideoTrack = {
      ...newTrack,
      id: previousTrack.id,
      offset: previousTrack.offset,
      selected: previousTrack.selected
    };

    // Remove only work belonging to the old source. Other tracks and their
    // selection state remain untouched.
    uploadQueue = uploadQueue.filter(item => item.trackId !== previousTrack.id);
    tracks[trackIndex] = replacement;
    videoFile = replacement.videoFile;
    startTime = replacement.startTime;
    endTime = replacement.endTime;
    volume = replacement.volume;
    selectedCompressionMode = replacement.compressionMode;
    duration = replacement.duration;
    currentTime = 0;
    return true;
  }

  async function replaceActiveTrackFromFile(file: File): Promise<void> {
    if (!browser) return;
    if (MAX_UPLOAD_BYTES !== null && file.size > MAX_UPLOAD_BYTES) {
      displayStatus(`File "${file.name}" is too large.`, 'error');
      return;
    }

    const replacement: VideoTrack = {
      id: crypto.randomUUID(),
      videoFile: file,
      filePath: null,
      fileSizeBytes: file.size,
      startTime: '00:00:00.000',
      endTime: '00:00:00.000',
      offset: 0,
      volume: 1,
      compressionMode: selectedCompressionMode,
      uploadedVideoId: null,
      endTimeManuallySet: false,
      selected: false,
      duration: 0
    };

    if (replaceActiveTrack(replacement)) {
      addToUploadQueue(file, activeTrackId!);
      displayStatus(`Active track changed to "${file.name}"`, 'success');
    }
  }

  // Get file metadata (name and size) without loading the file into memory
  async function getFileMetadata(filePath: string): Promise<{ name: string; size: number }> {
    if (!browser) throw new Error('Browser not available');
    
    const fileName = filePath.split(/[\\/]/).pop() || 'video.mp4';
    
    try {
      // @ts-ignore - Tauri API
      const { stat } = await import('@tauri-apps/plugin-fs');
      const fileStats = await stat(filePath);
      const size = fileStats.size || 0;
      
      return { name: fileName, size };
    } catch (error) {
      console.error('Error getting file metadata:', error);
      throw error;
    }
  }

  async function createLibraryTrack(path: string) {
    const metadata = await getFileMetadata(path);
    const rememberedState = loadLibraryClipState(path);

    return {
      id: crypto.randomUUID(),
      videoFile: null,
      filePath: path,
      fileSizeBytes: metadata.size,
      startTime: rememberedState?.startTime ?? "00:00:00.000",
      endTime: rememberedState?.endTime ?? "00:00:00.000",
      offset: 0,
      volume: rememberedState?.volume ?? 1,
      compressionMode: rememberedState?.compressionMode ?? selectedCompressionMode,
      uploadedVideoId: null,
      endTimeManuallySet: rememberedState?.endTimeManuallySet ?? !!rememberedState?.endTime,
      selected: false,
      duration: 0
    };
  }

  /** Path-based tracks: server registers the absolute path without buffering or copying the source video. */
  async function uploadLibraryFileFromServerPath(absolutePath: string): Promise<{ videoId: string; status: string }> {
    const response = await fetch(`${API_BASE}/upload-from-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absolutePath })
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `Server copy failed (${response.status})`;
      try {
        const errBody = JSON.parse(text) as { error?: string; message?: string };
        message = errBody.message || errBody.error || message;
      } catch {
        /* keep message */
      }
      throw new Error(message);
    }
    return JSON.parse(text) as { videoId: string; status: string };
  }

  
  // Load multiple videos in parallel with aggregate progress
  async function loadMultipleVideosFromPaths(paths: string[]): Promise<void> {
    if (!browser || paths.length === 0) return;
    
    try {
      // Show loading indicator
      showLoadingOverlay = true;
      loadingTitle = "Loading Videos";
      loadingMessage = `Loading ${paths.length} video${paths.length !== 1 ? 's' : ''} from library...`;
      useSpinner = true;
      
      // Create tracks immediately without loading files (like trimmer does)
      // This prevents CPU spikes by not loading files into memory
      for (let index = 0; index < paths.length; index++) {
        const path = paths[index];
        const fileName = path.split(/[\\/]/).pop() || 'video.mp4';
        const newTrack = await createLibraryTrack(path);
        
        tracks = [...tracks, newTrack];
        

        

        // If this is the first track or no active track, set it as active
        if (!activeTrackId || tracks.length === 1) {
          setActiveTrack(newTrack.id);
        }
        
        // Add to upload queue with filePath (not File) - upload queue will load it lazily
        // This is identical to how trimmer handles it - no CPU spike
        addToUploadQueue(null, newTrack.id, path);
        
        // Hide loading overlay as soon as first video is ready
        if (index === 0) {
          showLoadingOverlay = false;
          displayStatus(`"${fileName}" ready - ${paths.length - 1} more in queue...`, 'success');
        }
      }
      
      // All videos added successfully - files will be loaded lazily during upload (no CPU spike)
    } catch (error) {
      console.error('Error loading multiple videos:', error);
      showLoadingOverlay = false;
      displayStatus('Failed to load videos from library', 'error');
    }
  }
  
  // Update the existing handleFileChange function with deferred processing
  async function handleFileChange(event: Event): Promise<void> {
    if (!browser) return;
    
    // Defer processing to improve page load performance
    await new Promise(resolve => setTimeout(resolve, 0));
    
    const target = event.target as HTMLInputElement;
    const files = target.files;
    
    if (files && files.length > 0) {
      // Handle multiple files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Check if it's a video file
        if (!file.type.startsWith('video/')) {
          displayStatus(`"${file.name}" is not a valid video file.`, 'error');
          continue;
        }

        await handleSingleFileUpload(file);
      }
    }
    
    // Clear the input value to ensure the change event fires even if selecting the same file
    target.value = '';
  }

  async function handleFileChangeForReplacement(event: Event): Promise<void> {
    if (!browser) return;
    await new Promise(resolve => setTimeout(resolve, 0));

    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      if (!file.type.startsWith('video/')) {
        displayStatus(`"${file.name}" is not a valid video file.`, 'error');
      } else {
        await replaceActiveTrackFromFile(file);
      }
    }
    target.value = '';
  }

  // Cleanup effect for intervals
  $effect(() => {
    return () => {
      if (serverCheckInterval) clearInterval(serverCheckInterval);
      if (previewInterval) clearInterval(previewInterval);
      if (uploadController) uploadController.abort();
      videoSource.dispose();
    };
  });

  // Safe video player operations
  function safeVideoOperation(operation: (player: HTMLVideoElement) => void): void {
    if (videoPlayer) {
      operation(videoPlayer);
    }
  }

  // Video player manager effect with type safety
  $effect(() => {
    if (!videoPlayerReady) return;

    const player = videoPlayer!; 
    player.volume = volume;
    
    const handlers = {
      timeupdate: () => {
        handlePlayerTimeUpdate(player);
      },
      loadedmetadata: () => {
        duration = player.duration;
        if (!tracks.find(t => t.id === activeTrackId)?.endTimeManuallySet) {
          endTime = formatTime(duration);
          saveTrackState();
        }
        // Update the active track's duration
        if (activeTrackId) {
          const trackIndex = tracks.findIndex(t => t.id === activeTrackId);
          if (trackIndex !== -1) {
            tracks[trackIndex].duration = duration;
          }
        }
      },
      play: () => {
        shouldStopPlaybackAtTrimEnd =
          Number.isFinite(endTimeSeconds) &&
          endTimeSeconds > startTimeSeconds &&
          player.currentTime <= endTimeSeconds;
        isPlaying = true;
      },
      pause: () => {
        isPlaying = false;
      },
      volumechange: () => {
        volume = player.volume;
        saveTrackState();
      }
    };

    // Add all event listeners
    Object.entries(handlers).forEach(([event, handler]) => {
      player.addEventListener(event, handler);
    });

    // Cleanup function
    return () => {
      Object.entries(handlers).forEach(([event, handler]) => {
        player.removeEventListener(event, handler);
      });
    };
  });

  function playFromStart(): void {
    safeVideoOperation((player) => {
      if (startTimeSeconds >= endTimeSeconds) {
        displayStatus('Start time must be less than end time!', 'error');
        return;
      }

      const request = ++playFromStartRequest;
      pendingTimelineUiTime = startTimeSeconds;

      preciseTimelineSeek(player, startTimeSeconds, () => {
        if (request !== playFromStartRequest) return;

        pendingTimelineUiTime = null;
        player.play().catch(error => {
          if (request !== playFromStartRequest) return;
          console.error('Play from start failed:', error);
          displayStatus('Failed to play from start', 'error');
        });
      });
    });
  }

  async function replaceActiveTrackFromPath(path: string): Promise<void> {
    try {
      const replacement = await createLibraryTrack(path);
      const fileName = path.split(/[\\/]/).pop() || 'video.mp4';
      if (replaceActiveTrack(replacement)) {
        addToUploadQueue(null, activeTrackId!, path);
        displayStatus(`Active track changed to "${fileName}"`, 'success');
      }
    } catch (error) {
      console.error('Error replacing active track from path:', error);
      displayStatus('Failed to change the active track video', 'error');
    }
  }

  // Event listeners effect
  $effect(() => {
    if (browser) {
      document.addEventListener('keydown', handleKeyboardShortcuts);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      return () => {
        document.removeEventListener('keydown', handleKeyboardShortcuts);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  });

  onMount(async () => {
    if (browser) {
      isEditorMounted = true;
      const savedSession = restoreEditorSession();
      if (savedSession && savedSession.tracks.length > 0) {
        tracks = savedSession.tracks;
        uploadQueue = savedSession.uploadQueue;
        activeTrackId = null;
        const restoredActiveTrackId = savedSession.tracks.some(
          track => track.id === savedSession.activeTrackId
        )
          ? savedSession.activeTrackId
          : savedSession.tracks[0].id;
        if (restoredActiveTrackId) setActiveTrack(restoredActiveTrackId);
      }
      syncLayoutFromWindow();
      window.addEventListener('resize', syncLayoutFromWindow);
      window.addEventListener('beforeunload', handleEditorBeforeUnload);
      window.addEventListener('pagehide', persistEditorStateBeforeLeave);

      try {
        hiddenCompressionPresetIds = JSON.parse(localStorage.getItem(HIDDEN_COMPRESSION_PRESETS_KEY) ?? '[]');
      } catch {
        hiddenCompressionPresetIds = [];
      }

      const savedChangeVideoSource = localStorage.getItem(CHANGE_VIDEO_SOURCE_KEY);
      if (savedChangeVideoSource === 'file' || savedChangeVideoSource === 'library') {
        preferredChangeVideoSource = savedChangeVideoSource;
      }

      // Backend startup is intentionally independent from first paint. Check it
      // in the background so a slow Node launch never delays editor setup.
      void loadServerInit();
      serverCheckInterval = setInterval(checkServerConnection, 30000);

      const savedOutputDirectory = localStorage.getItem(OUTPUT_DIRECTORY_KEY);
      if (savedOutputDirectory) {
        try {
          const { invoke, isTauri } = await import('@tauri-apps/api/core');
          if (await isTauri() && await invoke<boolean>('is_output_path_authorized', { path: savedOutputDirectory })) {
            outputDirectory = savedOutputDirectory;
          } else {
            localStorage.removeItem(OUTPUT_DIRECTORY_KEY);
          }
        } catch {
          localStorage.removeItem(OUTPUT_DIRECTORY_KEY);
        }
      }
      generateOutputFilename = localStorage.getItem(GENERATE_OUTPUT_FILENAME_KEY) === 'true';
      hardwareAccelerationEnabled = localStorage.getItem(HARDWARE_ACCELERATION_KEY) === 'true';
      popupNotificationsEnabled = localStorage.getItem(POPUP_NOTIFICATIONS_KEY) === 'true';
      
      // Add page lifecycle event listeners for better back/forward cache handling
      document.addEventListener('pageshow', handlePageShow);
      
      // Optimize file chooser usage for bfcache compatibility
      document.addEventListener('visibilitychange', handleVisibilityChange);

      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlistenTauriFileDrop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            isDragOver = true;
            return;
          }

          isDragOver = false;
          dragCounter = 0;

          if (event.payload.type === 'drop') {
            void handleDroppedFilePaths(event.payload.paths);
          }
        });
      } catch (error) {
        console.debug('Tauri file drop events are unavailable in this environment:', error);
      }

      const mediaPickerMode = (localStorage.getItem(EDITOR_MEDIA_PICKER_MODE_KEY) === 'replace'
        ? 'replace'
        : 'add') satisfies EditorMediaPickerMode;
      localStorage.removeItem(EDITOR_MEDIA_PICKER_MODE_KEY);

      // Check if videos were selected from the library (multi-selection mode)
      const multiSelectMode = localStorage.getItem('multiSelectMode');
      if (multiSelectMode === 'true') {
        localStorage.removeItem('multiSelectMode');
        const selectedVideoPaths = localStorage.getItem('selectedVideoPaths');
        if (selectedVideoPaths) {
          try {
            const paths: string[] = JSON.parse(selectedVideoPaths);
            localStorage.removeItem('selectedVideoPaths');

            if (mediaPickerMode === 'replace' && paths.length > 0) {
              await replaceActiveTrackFromPath(paths[0]);
            } else {
              await loadMultipleVideosFromPaths(paths);
            }
          } catch (error) {
            console.error('Error loading selected videos:', error);
            displayStatus('Failed to load selected videos', 'error');
          }
        }
      } else {
        // Check if a single video was selected from the library
        const selectedVideoPath = localStorage.getItem('selectedVideoPath');
        if (selectedVideoPath) {
          localStorage.removeItem('selectedVideoPath');
          try {
            if (mediaPickerMode === 'replace') {
              await replaceActiveTrackFromPath(selectedVideoPath);
            } else {
              const fileName = selectedVideoPath.split(/[\\/]/).pop() || 'video.mp4';
              const newTrack = await createLibraryTrack(selectedVideoPath);

              tracks = [...tracks, newTrack];

              if (!activeTrackId || tracks.length === 1) {
                setActiveTrack(newTrack.id);
              }

              addToUploadQueue(null, newTrack.id, selectedVideoPath);
              displayStatus(`"${fileName}" ready`, 'success');
            }
          } catch (error) {
            console.error('Error loading video from path:', error);
            showLoadingOverlay = false;
            displayStatus('Failed to load video from library', 'error');
          }
        }
      }
      if (uploadQueue.some(item => item.status === 'pending') && !isProcessingQueue) {
        void processUploadQueue();
      }
      isRestoringLibrarySelection = false;
    }
  });

  onDestroy(() => {
    isEditorMounted = false;
    if (browser) {
      window.removeEventListener('resize', syncLayoutFromWindow);
      window.removeEventListener('beforeunload', handleEditorBeforeUnload);
      window.removeEventListener('pagehide', persistEditorStateBeforeLeave);
      persistEditorStateBeforeLeave();

      if (serverCheckInterval) {
        clearInterval(serverCheckInterval);
      }
      if (previewInterval) {
        clearInterval(previewInterval);
      }
      if (uploadController) {
        uploadController.abort();
      }
      if (unlistenTauriFileDrop) {
        unlistenTauriFileDrop();
        unlistenTauriFileDrop = null;
      }
      // Clean up track drag listeners if still attached
      document.removeEventListener('mousemove', handleTrackMouseMove);
      document.removeEventListener('mouseup', handleTrackMouseUp);
      
      document.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  });

  // Helper functions
  function updateServerStatus(message: string, isOnline: boolean = false): void {
    serverStatusMessage = message;
    serverStatusClass = 'server-status';
    
    if (isOnline) {
      serverStatusClass += ' online';
      serverOnline = true;
    } else {
      serverStatusClass += ' offline';
      serverOnline = false;
    }
  }

  /** Load health + compression modes, allowing the bundled backend time to start. */
  async function loadServerInit(): Promise<void> {
    if (!browser) return;

    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${API_BASE}/init`);
        if (!response.ok) throw new Error('Server responded with error');

        const data = await response.json();
        applyCompressionModes(data.modes ?? [], data.default);
        updateServerStatus('Server online - Ready to process videos!', true);
        return;
      } catch (error: unknown) {
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Server init error:', errorMessage);
        updateServerStatus('Server offline - Please start the Node.js server', false);
      }
    }
  }

  async function checkServerConnection(): Promise<void> {
    if (!browser) return;
    
    try {
      const response = await fetch(`${API_BASE}/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        updateServerStatus('Server online - Ready to process videos!', true);
        if (compressionModes.length === 0) {
          try {
            const modesRes = await fetch(`${API_BASE}/compression-modes`);
            if (modesRes.ok) {
              const data = await modesRes.json();
              applyCompressionModes(data.modes ?? [], data.default);
            }
          } catch {
            /* ignore */
          }
        }
      } else {
        throw new Error('Server responded with error');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Server connection error:', errorMessage);
      updateServerStatus('Server offline - Please start the Node.js server', false);
    }
  }

  // Check if video already exists on server
  async function checkVideoExists(file: File): Promise<string | null> {
    try {
      // First check if video already exists BEFORE uploading (saves resources)
      const checkResponse = await fetch(`${API_BASE}/check-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filename: file.name,
          size: file.size
        })
      });
      
      if (checkResponse.ok) {
        const checkResult = await checkResponse.json();
        
        if (checkResult.exists) {
          // Video already exists, return existing ID without uploading
          console.log(`Video "${file.name}" already exists on server with ID: ${checkResult.videoId}`);
          return checkResult.videoId;
        }
      }
      
      // Video doesn't exist, proceed with upload
      const formData = new FormData();
      formData.append('video', file);
      
      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.status === 'already_uploaded') {
          console.log(`Video "${file.name}" already exists on server with ID: ${result.videoId}`);
          return result.videoId;
        } else if (result.status === 'uploaded') {
          return result.videoId;
        }
      }
      return null;
    } catch (error) {
      console.error('Error checking video existence:', error);
      return null;
    }
  }

  // Add file to upload queue (supports both File objects and file paths)
  function addToUploadQueue(file: File | null, trackId: string, filePath?: string): void {
    const fileName = getUploadQueueFileName(file, filePath);

    // Check if file with same name is already in queue or completed
    const existingInQueue = findReusableUploadQueueItem(uploadQueue, file, filePath);
    
    if (existingInQueue) {
      console.log(`File "${fileName}" is already in the upload queue`);
      // If it's completed, link the existing videoId to this track
      if (existingInQueue.status === 'completed' && existingInQueue.videoId) {
        const trackIndex = tracks.findIndex(t => t.id === trackId);
        if (trackIndex !== -1) {
          tracks[trackIndex].uploadedVideoId = existingInQueue.videoId;
        }
        displayStatus(`Using existing upload for "${fileName}"`, 'success');
      }
      return;
    }
    
    uploadQueue = [...uploadQueue, createUploadQueueItem(file, trackId, filePath)];
    
    // Start processing queue if not already processing
    if (!isProcessingQueue) {
      processUploadQueue();
    }
  }

  // Process upload queue sequentially
  async function processUploadQueue(): Promise<void> {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (uploadQueue.length > 0) {
      const queueItem = uploadQueue.find(item => item.status === 'pending');
      if (!queueItem) break;

      const currentTrackId = queueItem.trackId;

      const updateQueueItem = (updates: Partial<typeof queueItem>) => {
        const item = uploadQueue.find(item => item === queueItem);
        if (item) Object.assign(item, updates);
      };

      const trackStillUsesQueueSource = () => {
        const track = tracks.find(item => item.id === currentTrackId);
        return !!track && track.videoFile === queueItem.file && track.filePath === queueItem.filePath;
      };

      updateQueueItem({ status: 'uploading' });

      let result: { videoId: string; status: string } | undefined;

      try {
        isUploading = true;
        uploadProgress = 0;

        let fileName: string;
        let fileSize: number;

        if (queueItem.file) {
          fileName = queueItem.file.name;
          fileSize = queueItem.file.size;
        } else if (queueItem.filePath) {
          const metadata = await getFileMetadata(queueItem.filePath);
          fileName = metadata.name;
          fileSize = metadata.size;

          const trackIndex = tracks.findIndex(t => t.id === currentTrackId);
          if (trackIndex !== -1) {
            tracks[trackIndex].fileSizeBytes = metadata.size;
          }
        } else {
          throw new Error('No file or file path available for upload');
        }

        if (!queueItem.filePath) {
          // Browser File uploads still use the legacy uploads directory lookup.
          const checkResponse = await fetch(`${API_BASE}/check-video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: fileName, size: fileSize })
          });

          if (checkResponse.ok) {
            const checkResult = await checkResponse.json();

            if (checkResult.exists) {
              result = {
                videoId: checkResult.videoId,
                status: checkResult.status ?? 'skipped'
              };

              updateQueueItem({
                videoId: result.videoId,
                progress: 100,
                status: 'skipped'
              });
              displayStatus(`"${fileName}" already exists on server`, 'success');

              // Update track immediately for skipped videos
              if (trackStillUsesQueueSource()) {
                updateTrackUploadedVideoId(currentTrackId, result.videoId);
              }
              continue;
            }
          } else {
            console.warn('Check endpoint failed, falling back to direct upload');
          }
        }

        // ====================== UPLOAD ======================
        if (queueItem.filePath && !queueItem.file) {
          uploadProgress = 5;
          updateQueueItem({ progress: 5 });
          result = await uploadLibraryFileFromServerPath(queueItem.filePath);
          uploadProgress = 100;
          updateQueueItem({ progress: 100 });
        } else {
          const fileToUpload = queueItem.file;
          if (!fileToUpload) {
            throw new Error('No file or file path available for upload');
          }

          const formData = new FormData();
          formData.append('video', fileToUpload);

          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${API_BASE}/upload`, true);
          xhr.setRequestHeader('X-Video-Trimmer-Token', await getBackendToken());

          xhr.upload.onprogress = (e: ProgressEvent) => {
            if (e.lengthComputable) {
              const progress = (e.loaded / e.total) * 100;
              uploadProgress = progress;
              updateQueueItem({ progress });
            }
          };

          result = await new Promise((resolve, reject) => {
            xhr.onload = () => {
              if (xhr.status === 200) {
                try {
                  resolve(JSON.parse(xhr.responseText));
                } catch {
                  reject(new Error('Invalid server response'));
                }
              } else {
                reject(new Error(`Upload failed with status ${xhr.status}`));
              }
            };
            xhr.onerror = () => reject(new Error('Network error during upload'));
            xhr.send(formData);
          });
        }

        updateQueueItem({ 
          videoId: result?.videoId, 
          progress: 100 
        });

        if (result?.status === 'already_uploaded') {
          updateQueueItem({ status: 'skipped' });
          displayStatus(`"${fileName}" already exists on server`, 'success');
        } else if (queueItem.filePath && !queueItem.file) {
          updateQueueItem({ status: 'completed' });
          displayStatus(`"${fileName}" registered successfully`, 'success');
        } else {
          updateQueueItem({ status: 'completed' });
          displayStatus(`"${fileName}" uploaded successfully`, 'success');
        }

      } catch (error: unknown) {
        console.error('Upload error:', error);
        const fileName = queueItem.file?.name || queueItem.filePath?.split(/[\\/]/).pop() || 'video';
        updateQueueItem({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        displayStatus(`Failed to upload "${fileName}"`, 'error');
      } finally {
        isUploading = false;
      }

      // Safely update track (only if we have a successful result)
      if (result?.videoId && trackStillUsesQueueSource()) {
        updateTrackUploadedVideoId(currentTrackId, result.videoId);
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    isProcessingQueue = false;

    // Cleanup
    setTimeout(() => {
      uploadQueue = uploadQueue.filter(item =>
        item.status !== 'completed' && item.status !== 'skipped'
      );
    }, 5000);
  }

  // Upload queue helper
  function updateTrackUploadedVideoId(trackId: string, videoId: string) {
    const trackIndex = tracks.findIndex(t => t.id === trackId);
    if (trackIndex !== -1) {
      tracks[trackIndex].uploadedVideoId = videoId;
    }
  }

  function updateTrimDuration(): void {
    const startTimeSeconds = parseTime(startTime);
    const endTimeSeconds = parseTime(endTime);
    const duration = Math.max(0, endTimeSeconds - startTimeSeconds);
    trimDuration = formatTime(duration);
  }

  function displayStatus(message: string, type: string): void {
    if (!popupNotificationsEnabled) return;

    statusMessage = message;
    statusType = type;
    showStatus = true;
    
    setTimeout(() => {
      showStatus = false;
    }, 5000);
  }

  function setCurrentAsStart(): void {
    if (videoPlayer) {
      startTime = formatTime(videoPlayer.currentTime);
      updateTrimDuration();
      saveTrackState();
    }
  }

  function setCurrentAsEnd(): void {
    if (videoPlayer) {
      endTime = formatTime(videoPlayer.currentTime);
      updateTrimDuration();
      saveTrackState();
      
      // Set the flag when user manually sets end time
      if (activeTrackId) {
        const trackIndex = tracks.findIndex(t => t.id === activeTrackId);
        if (trackIndex !== -1) {
          tracks[trackIndex].endTimeManuallySet = true;
          saveTrackState();
        }
      }
    }
  }

  function handleMouseMove(event: MouseEvent): void {
    if (
      isTimelinePlayheadScrubbing &&
      event.buttons === 1 &&
      !isDraggingStart &&
      !isDraggingEnd
    ) {
      if (!videoPlayerReady || duration === 0) return;
      const timeline = document.querySelector('.timeline-container') as HTMLElement;
      if (!timeline) return;
      const rect = timeline.getBoundingClientRect();
      scrubPointerTime = timeFromTimelineClientX(event.clientX, rect, duration);
      safeVideoOperation((player) => {
        smoothTimelineSeek(player, scrubPointerTime, playheadScrubThrottle);
      });
      return;
    }

    if (!isDraggingStart && !isDraggingEnd) return;
    if (!duration || duration === 0) return;

    const timeline = document.querySelector('.timeline-container') as HTMLElement;
    if (!timeline) return;

    safeVideoOperation((player) => {
      if (!player.paused) {
        player.pause();
      }

      isUserSeeking = true;

      const rect = timeline.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const percentage = x / rect.width;
      const newTime = percentage * duration;

      const minGap = 0.05; // Minimum 50ms gap between markers

      if (isDraggingStart) {
        const endSeconds = parseTime(endTime);
        if (newTime < endSeconds - minGap) {
          const clampedTime = Math.max(0, Math.min(endSeconds - minGap, newTime));
          startTime = formatTime(clampedTime);
          smoothTimelineSeek(player, clampedTime, trimScrubThrottle);
        }
      } else if (isDraggingEnd) {
        const startSeconds = parseTime(startTime);
        if (newTime > startSeconds + minGap) {
          const clampedTime = Math.max(startSeconds + minGap, Math.min(duration, newTime));
          endTime = formatTime(clampedTime);
          smoothTimelineSeek(player, clampedTime, trimScrubThrottle);

          if (activeTrackId) {
            const trackIndex = tracks.findIndex(t => t.id === activeTrackId);
            if (trackIndex !== -1) {
              tracks[trackIndex].endTimeManuallySet = true;
              saveTrackState();
            }
          }
        }
      }
      updateTrimDuration();
    });
  }

  function handleMouseUp(): void {
    if (isTimelinePlayheadScrubbing) {
      isTimelinePlayheadScrubbing = false;
      resetTimelineScrubThrottle(playheadScrubThrottle);
      if (videoPlayer && duration > 0) {
        pendingTimelineUiTime = scrubPointerTime;
        preciseTimelineSeek(videoPlayer, scrubPointerTime, () => {
          pendingTimelineUiTime = null;
        });
      }
    }

    const wasDraggingStart = isDraggingStart;
    const wasDraggingEnd = isDraggingEnd;
    const wasDragging = wasDraggingStart || wasDraggingEnd;
    const trimPreciseTime = wasDraggingStart
      ? parseTime(startTime)
      : wasDraggingEnd
        ? parseTime(endTime)
        : 0;

    isDraggingStart = false;
    isDraggingEnd = false;

    if (wasDragging) {
      saveTrackState();
      resetTimelineScrubThrottle(trimScrubThrottle);
      if (videoPlayer && duration > 0) {
        // Keep the playhead UI stable until the seek has settled.
        pendingTimelineUiTime = trimPreciseTime;
        preciseTimelineSeek(videoPlayer, trimPreciseTime, () => {
          pendingTimelineUiTime = null;
        });
      }
    }
  }

  function handleStartMarkerMouseDown(event: MouseEvent): void {
    event.stopPropagation();
    resetTimelineScrubThrottle(trimScrubThrottle);
    isDraggingStart = true;
  }

  function handleEndMarkerMouseDown(event: MouseEvent): void {
    event.stopPropagation();
    resetTimelineScrubThrottle(trimScrubThrottle);
    isDraggingEnd = true;
    
    // Set the endTimeManuallySet flag when starting to drag the end marker
    if (activeTrackId) {
      const trackIndex = tracks.findIndex(t => t.id === activeTrackId);
      if (trackIndex !== -1) {
        tracks[trackIndex].endTimeManuallySet = true;
        saveTrackState();
      }
    }
  }

  // Keyboard shortcut handler with type safety
  function handleKeyboardShortcuts(e: KeyboardEvent): void {
    handleEditorKeybind(
      e,
      {
        browser,
        controlsEnabled,
        overlaysOpen: showTracksOverlay || showTrimOverlay,
        isDraggingStart,
        isDraggingEnd,
        isTimelinePlayheadScrubbing
      },
      {
        closeSidebarOverlays,
        navigateToLibrary,
        toggleFullscreen,
        setCurrentAsStart: () => {
          setCurrentAsStart();
          displayStatus('Start time set to current position', 'success');
        },
        setCurrentAsEnd: () => {
          setCurrentAsEnd();
          displayStatus('End time set to current position', 'success');
        },
        playFromStart,
        togglePlayback: () => {
          safeVideoOperation((player) => {
            if (player.paused) {
              const isAtTrimEnd =
                Number.isFinite(endTimeSeconds) &&
                endTimeSeconds > startTimeSeconds &&
                Math.abs(player.currentTime - endTimeSeconds) <= 0.05;

              if (isAtTrimEnd) {
                pendingTimelineUiTime = startTimeSeconds;
                preciseTimelineSeek(player, startTimeSeconds, () => {
                  pendingTimelineUiTime = null;
                  player.play().catch((error) => {
                    console.error('Playback restart failed:', error);
                  });
                });
              } else {
                player.play().catch((error) => {
                  console.error('Playback failed:', error);
                });
              }
            } else {
              player.pause();
            }
          });
        },
        stepFrame: (direction) => {
          safeVideoOperation((player) => {
            isUserSeeking = true;
            const frameTime = 1 / 30;
            player.currentTime =
              direction < 0
                ? Math.max(0, player.currentTime - frameTime)
                : Math.min(duration, player.currentTime + frameTime);
            window.setTimeout(() => {
              isUserSeeking = false;
            }, 100);
          });
        }
      }
    );
  }

  // Job status polling function
  async function pollJobStatus(jobId: string): Promise<void> {
    const pollIntervalMs = 500;
    const progressCreepPerSecond = 0.16;
    const maxCreepAheadPercent = 4;
    let startTime = Date.now();
    let lastProgressPercent = 0;
    let lastServerProgress = 0;
    let lastServerProgressAt = Date.now();
    let activeAnimationCancel: (() => void) | null = null;
    
    function animateProgress(targetProgress: number, durationMs: number = 500) {
      activeAnimationCancel?.();
      activeAnimationCancel = animateProgressValue({
        from: progressPercent,
        to: Math.max(0, Math.min(100, targetProgress)),
        durationMs,
        setValue: (value) => {
          progressPercent = value;
        }
      });
    }

    function readProgress(value: unknown): number {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.min(100, value));
      }

      const progressMatch = String(value ?? '').match(/(\d+(?:\.\d+)?)%/);
      if (!progressMatch) return 0;
      return Math.max(0, Math.min(100, parseFloat(progressMatch[1])));
    }

    function getDisplayedProcessingProgress(serverProgress: number): number {
      if (serverProgress < lastServerProgress - 5) {
        lastServerProgress = serverProgress;
        lastServerProgressAt = Date.now();
        return serverProgress;
      }

      if (serverProgress > lastServerProgress) {
        lastServerProgress = serverProgress;
        lastServerProgressAt = Date.now();
        return serverProgress;
      }

      if (serverProgress >= 99) return serverProgress;

      const secondsSinceServerUpdate = (Date.now() - lastServerProgressAt) / 1000;
      const creepAhead = Math.min(maxCreepAheadPercent, secondsSinceServerUpdate * progressCreepPerSecond);
      return Math.min(97, lastServerProgress + creepAhead);
    }
    
    return new Promise<void>((resolve, reject) => {
      let pollTimeout: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (pollTimeout) {
          clearTimeout(pollTimeout);
          pollTimeout = null;
        }
        activeAnimationCancel?.();
        activeAnimationCancel = null;
        resolve();
      };

      const fail = (error: unknown) => {
        if (pollTimeout) {
          clearTimeout(pollTimeout);
          pollTimeout = null;
        }
        activeAnimationCancel?.();
        activeAnimationCancel = null;
        reject(error);
      };

      const checkStatus = async (): Promise<void> => {
        try {
          const response = await fetch(`${API_BASE}/status/${jobId}`);
        
        if (!response.ok) {
          throw new Error(`Status check failed: ${response.status} ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('Job status:', result);
        
        if (result.status === 'completed') {
          loadingTitle = 'Processing Complete!';
          loadingMessage = 'Video processed and saved successfully.';
          activeAnimationCancel?.();
          progressPercent = 100;
          completedOutput = {
            outputSize: String(result.outputSize ?? '0'),
            outputPath: String(result.outputPath ?? ''),
            filename: String(result.filename ?? 'trimmed-video.mp4'),
            timeTaken: formatElapsedTime(
              Math.max(
                0,
                Math.round(
                  Number.isFinite(Number(result.processingTime))
                    ? Number(result.processingTime)
                    : (Date.now() - startTime) / 1000
                )
              )
            ),
            preset: String(result.compressionName ?? 'Unknown preset')
          };
          isProcessing = false;
          currentJobId = null;
          displayStatus('Video processed and saved', 'success');
          finish();
          return;
        } 
        else if (result.status === 'failed') {
          showLoadingOverlay = false;
          isProcessing = false;
          currentJobId = null;
          fail(new Error(result.error || 'Processing failed on server'));
          return;
        }
        else if (result.status === 'cancelled') {
          showLoadingOverlay = false;
          isProcessing = false;
          currentJobId = null;
          displayStatus('Job was cancelled', 'error');
          finish();
          return;
        }
        else if (result.status === 'processing') {
          loadingTitle = 'Processing Video';
          let progressMessage = result.progressMessage || 'Processing video...';
          const serverProgress = readProgress(result.progress);
          const targetProgress = getDisplayedProcessingProgress(serverProgress);
          
          // Check if this is a new iteration (progress reset to 0 after being higher)
          if (targetProgress === 0 && lastProgressPercent > 0) {
            // Reset progress immediately for new iteration
            activeAnimationCancel?.();
            progressPercent = 0;
            lastProgressPercent = 0;
            // Update title to show iteration info if available
            if (result.progressMessage && result.progressMessage.includes('Iteration')) {
              loadingTitle = result.progressMessage.split(':')[0]; // Extract "Iteration X/Y" part
            }
          } 
          else if (targetProgress > lastProgressPercent + 0.1) {
            animateProgress(targetProgress, pollIntervalMs * 1.4);
            lastProgressPercent = targetProgress;
          }
          
          // Add iteration information if available
          if (result.iteration && result.totalIterations && result.iteration > 1) {
            progressMessage = `Iteration ${result.iteration}/${result.totalIterations}\n${progressMessage}`;
          }

          // Add file information
          
          if (result.inputSize) {
            progressMessage += `\nInput Size: ${result.inputSize} MB`;
          }
          
          // Add compression mode info
          if (result.compressionName) {
            progressMessage += `\nMode: ${result.compressionName}`;
          }
          
          // Calculate and show elapsed time and estimated completion
          const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
          const elapsedTime = formatElapsedTime(elapsedSeconds);
          progressMessage += `\nElapsed: ${elapsedTime}`;
          
          
          // Show estimated time if available and we have some progress
          if (progressPercent > 1 && progressPercent < 99) {
            const estimatedTotalSeconds = (elapsedSeconds / progressPercent) * 100;
            const remainingSeconds = Math.max(0, estimatedTotalSeconds - elapsedSeconds);
            const estimatedRemaining = formatElapsedTime(Math.floor(remainingSeconds));
            progressMessage += `\nETA: ${estimatedRemaining}`;
          }
          
          loadingMessage = progressMessage;
        }

        // Continue polling
        pollTimeout = setTimeout(checkStatus, pollIntervalMs);
        
        } catch (error) {
          console.error('Status check error:', error);
          showLoadingOverlay = false;
          isProcessing = false;
          currentJobId = null;
          fail(error);
        }
      };
    
      void checkStatus();
    });
  }

  function setPopupNotificationsEnabled(enabled: boolean): void {
    popupNotificationsEnabled = enabled;
    localStorage.setItem(POPUP_NOTIFICATIONS_KEY, String(enabled));
    if (!enabled) showStatus = false;
  }

  function persistOutputDirectory(): void {
    if (!browser) return;
    if (outputDirectory) {
      localStorage.setItem(OUTPUT_DIRECTORY_KEY, outputDirectory);
    } else {
      localStorage.removeItem(OUTPUT_DIRECTORY_KEY);
    }
  }

  async function chooseOutputDirectory(): Promise<boolean> {
    if (!browser) return false;

    try {
      const { isTauri } = await import('@tauri-apps/api/core');
      if (!(await isTauri())) {
        displayStatus(
          'Folder selection is only available in the desktop app. Please use the desktop version.',
          'error'
        );
        return false;
      }

      const { invoke } = await import('@tauri-apps/api/core');
      const selected = await invoke<string | null>('pick_output_directory');

      if (typeof selected === 'string') {
        outputDirectory = selected;
        persistOutputDirectory();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to select output directory:', error);
      displayStatus('Failed to select output folder', 'error');
      return false;
    }
  }

  function clearOutputDirectory(): void {
    outputDirectory = '';
    persistOutputDirectory();
  }

  function normalizeOutputFilename(filename: string): string {
    const trimmed = filename.trim();
    if (!trimmed) return '';
    return trimmed.toLowerCase().endsWith('.mp4') ? trimmed : `${trimmed}.mp4`;
  }

  function validateOutputFilename(filename: string): string {
    if (!filename) return 'Enter an output file name.';
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(filename) || filename.endsWith('.') || filename.endsWith(' ')) {
      return 'Use a file name without folder paths or reserved characters.';
    }
    return '';
  }

  function setOutputFilename(filename: string): void {
    outputFilename = filename;
  }

  function setGenerateOutputFilename(enabled: boolean): void {
    generateOutputFilename = enabled;
    if (!browser) return;
    localStorage.setItem(GENERATE_OUTPUT_FILENAME_KEY, String(enabled));
  }

  async function requestTrimmedVideo(): Promise<void> {
    outputFilename = '';
    outputOptionsError = '';

    if (generateOutputFilename) {
      await downloadTrimmedVideo();
      return;
    }

    showOutputOptions = true;
  }

  async function confirmOutputOptions(): Promise<void> {
    if (!generateOutputFilename) {
      const normalizedFilename = normalizeOutputFilename(outputFilename);
      const filenameError = validateOutputFilename(normalizedFilename);
      if (filenameError) {
        outputOptionsError = filenameError;
        return;
      }
      setOutputFilename(normalizedFilename);
    } else {
      outputFilename = '';
    }

    outputOptionsError = '';
    showOutputOptions = false;
    await downloadTrimmedVideo();
  }

  function closeCompletedOutput(): void {
    showLoadingOverlay = false;
    completedOutput = null;
  }

  async function openCompletedOutputLocation(): Promise<void> {
    if (!completedOutput?.outputPath) return;

    try {
      const { invoke, isTauri } = await import('@tauri-apps/api/core');
      if (!(await isTauri())) {
        displayStatus('Opening the output location is only available in the desktop app.', 'error');
        return;
      }
      await invoke('open_library_video_location', { videoPath: completedOutput.outputPath });
    } catch (error) {
      console.error('Failed to open output location:', error);
      displayStatus('Could not open the output file location', 'error');
    }
  }

  function setHardwareAccelerationEnabled(enabled: boolean): void {
    hardwareAccelerationEnabled = enabled;
    if (!browser) return;

    if (enabled) {
      localStorage.setItem(HARDWARE_ACCELERATION_KEY, 'true');
    } else {
      localStorage.removeItem(HARDWARE_ACCELERATION_KEY);
    }
  }

  function persistHiddenCompressionPresets(): void {
    if (!browser) return;
    localStorage.setItem(HIDDEN_COMPRESSION_PRESETS_KEY, JSON.stringify(hiddenCompressionPresetIds));
  }

  function refreshCompressionModeVisibility(): void {
    compressionModes = compressionModes.map((mode) => ({
      ...mode,
      hidden: hiddenCompressionPresetIds.includes(mode.id)
    }));

    const visibleModes = compressionModes.filter((mode) => !mode.hidden);
    if (!visibleModes.some((mode) => mode.id === selectedCompressionMode)) {
      selectedCompressionMode = visibleModes[0]?.id ?? selectedCompressionMode;
    }
  }

  function openCompressionPresetModal(preset?: CompressionPreset): void {
    editingCompressionPreset = preset && !preset.builtIn ? preset : null;
    compressionPresetError = '';
    compressionPresetModalOpen = true;
  }

  function closeCompressionPresetModal(): void {
    compressionPresetModalOpen = false;
    editingCompressionPreset = null;
    compressionPresetError = '';
  }

  async function readPresetApiError(response: Response): Promise<string> {
    try {
      const data = await response.json();
      return data.error ?? 'Could not save compression preset';
    } catch {
      return 'Could not save compression preset';
    }
  }

  async function saveCompressionPreset(preset: CompressionPreset): Promise<void> {
    if (!browser) return;

    compressionPresetSaving = true;
    compressionPresetError = '';

    try {
      const isEditing = Boolean(editingCompressionPreset?.id);
      const response = await fetch(
        isEditing
          ? `${API_BASE}/compression-modes/custom/${encodeURIComponent(editingCompressionPreset!.id)}`
          : `${API_BASE}/compression-modes/custom`,
        {
          method: isEditing ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(preset)
        }
      );

      if (!response.ok) {
        throw new Error(await readPresetApiError(response));
      }

      const data = await response.json();
      applyCompressionModes(data.modes ?? [], data.default);
      selectedCompressionMode = data.preset?.id ?? selectedCompressionMode;
      closeCompressionPresetModal();
      displayStatus(isEditing ? 'Compression preset updated' : 'Compression preset created', 'success');
    } catch (error) {
      compressionPresetError = error instanceof Error ? error.message : 'Could not save compression preset';
    } finally {
      compressionPresetSaving = false;
    }
  }

  function toggleCompressionPresetHidden(id: string): void {
    hiddenCompressionPresetIds = hiddenCompressionPresetIds.includes(id)
      ? hiddenCompressionPresetIds.filter((presetId) => presetId !== id)
      : [...hiddenCompressionPresetIds, id];
    persistHiddenCompressionPresets();
    refreshCompressionModeVisibility();
  }

  async function deleteCompressionPreset(preset: CompressionPreset): Promise<void> {
    if (!browser || preset.builtIn) return;
    if (!confirm(`Delete "${preset.name}"?`)) return;

    try {
      const response = await fetch(`${API_BASE}/compression-modes/custom/${encodeURIComponent(preset.id)}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(await readPresetApiError(response));
      }

      const data = await response.json();
      hiddenCompressionPresetIds = hiddenCompressionPresetIds.filter((id) => id !== preset.id);
      persistHiddenCompressionPresets();
      applyCompressionModes(data.modes ?? [], data.default);
      displayStatus('Compression preset deleted', 'success');
    } catch (error) {
      displayStatus(error instanceof Error ? error.message : 'Could not delete compression preset', 'error');
    }
  }

  // Download trimmed video function
  async function downloadTrimmedVideo(): Promise<void> {
    if (!browser) return;

    // Check if we have an active track with a video loaded
    if (!activeTrackId) {
      displayStatus('Please select a track to trim.', 'error');
      return;
    }

    const activeTrack = tracks.find(t => t.id === activeTrackId);
    if (!activeTrack || (!activeTrack.videoFile && !activeTrack.filePath)) {
      displayStatus('No video loaded in the active track.', 'error');
      return;
    }

    // Gather selected tracks for combining (only if more than one is selected)
    const selectedTracks = tracks.filter(t => t.selected);

    // If more than one track is selected, combine them
    if (selectedTracks.length > 1) {
      // Ensure all selected tracks are uploaded
      if (selectedTracks.some(t => !t.uploadedVideoId)) {
        displayStatus('Please wait for all selected tracks to finish uploading.', 'error');
        return;
      }

      // Validate times
      for (const t of selectedTracks) {
        const start = parseTime(t.startTime);
        const end = parseTime(t.endTime);
        if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
          displayStatus('Invalid start/end time in one of the selected tracks.', 'error');
          return;
        }
      }

      showLoadingOverlay = true;
      completedOutput = null;
      loadingMessage = 'Processing combined tracks...';
      loadingTitle = 'Combining & Trimming Videos';
      useSpinner = false;
      progressPercent = 0;
      isProcessing = true;

      try {
        const response = await fetch(`${API_BASE}/trim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            tracks: selectedTracks.map(t => ({
              videoId: t.uploadedVideoId,
              startTime: parseTime(t.startTime),
              endTime: parseTime(t.endTime)
            })),
            compressionMode: selectedCompressionMode,
            hardwareAcceleration: hardwareAccelerationEnabled,
            ...(outputFilename ? { outputFilename } : {}),
            ...(outputDirectory ? { outputDirectory } : {})
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to start combining');
        }

        const result = await response.json();
        currentJobId = result.jobId;
        await pollJobStatus(result.jobId);
      } catch (error: unknown) {
        showLoadingOverlay = false;
        isProcessing = false;
        currentJobId = null;
        console.error('Combine error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        displayStatus('Error processing videos: ' + errorMessage, 'error');
      }
      return;
    }

    // Single track (using active track)
    if (!activeTrack.uploadedVideoId) {
      displayStatus('Please wait for video upload to complete', 'error');
      return;
    }
    if (!serverOnline) {
      displayStatus('Server is offline. Please start the Node.js server.', 'error');
      return;
    }
    const startTimeSeconds = parseTime(startTime);
    const endTimeSeconds = parseTime(endTime);
    if (isNaN(startTimeSeconds) || startTimeSeconds < 0) {
      displayStatus('Invalid start time!', 'error');
      return;
    }
    if (isNaN(endTimeSeconds) || endTimeSeconds <= startTimeSeconds) {
      displayStatus('End time must be greater than start time!', 'error');
      return;
    }
    showLoadingOverlay = true;
    completedOutput = null;
    loadingMessage = 'Processing video...';
    const compressionPreset = compressionModes.find((mode) => mode.id === selectedCompressionMode);
    loadingTitle =
      compressionPreset?.processingStrategy === 'directCopy'
        ? 'Trimming Video'
        : `Trimming and Compressing Video (${compressionPreset?.name ?? selectedCompressionMode})`;
    useSpinner = false;
    progressPercent = 0;
    isProcessing = true;
    try {
      const response = await fetch(`${API_BASE}/trim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          videoId: activeTrack.uploadedVideoId,
          startTime: startTimeSeconds,
          endTime: endTimeSeconds,
          compressionMode: selectedCompressionMode,
          hardwareAcceleration: hardwareAccelerationEnabled,
          ...(outputFilename ? { outputFilename } : {}),
          ...(outputDirectory ? { outputDirectory } : {})
        })
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to start trimming');
      }
      const result = await response.json();
      currentJobId = result.jobId;
      await pollJobStatus(result.jobId);
    } catch (error: unknown) {
      showLoadingOverlay = false;
      isProcessing = false;
      currentJobId = null;
      console.error('Trim error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      displayStatus('Error processing video: ' + errorMessage, 'error');
    }
  }

  // Handle file change specifically for adding a new track with deferred processing
  async function handleFileChangeForNewTrack(event: Event): Promise<void> {
    if (!browser) return;
    
    // Defer processing to improve page load performance
    await new Promise(resolve => setTimeout(resolve, 0));
    
    const target = event.target as HTMLInputElement;
    const files = target.files;
    
    if (files && files.length > 0) {
      // Handle multiple files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // Check if it's a video file
        if (!file.type.startsWith('video/')) {
          displayStatus(`"${file.name}" is not a valid video file.`, 'error');
          continue;
        }

        await handleSingleFileUpload(file);
      }
    }
    
    target.value = '';
  }

  // Add fullscreen toggle function
  function toggleFullscreen(): void {
    isFullscreen = !isFullscreen;
    if (isFullscreen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }

  let selectedTrackCount = $derived(tracks.filter(t => t.selected).length);


  let volumeTimeout: ReturnType<typeof setTimeout>;

  function openVolume() {
    clearTimeout(volumeTimeout);
    showVolume = true;
  }

  function closeVolume() {
    volumeTimeout = setTimeout(() => {
      showVolume = false;
    }, 150);
  }

  // Cancel current processing job
  async function cancelCurrentJob(): Promise<void> {
    if (!currentJobId) {
      displayStatus('No job to cancel', 'error');
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/cancel/${currentJobId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        showLoadingOverlay = false;
        isProcessing = false;
        currentJobId = null;
        displayStatus('Job cancelled successfully', 'success');
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to cancel job');
      }
    } catch (error: unknown) {
      console.error('Cancel error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      displayStatus('Error cancelling job: ' + errorMessage, 'error');
    }
  }
</script>



<!-- Main Container -->
<div class="trimmer-scrollbar h-screen w-screen flex flex-col bg-gray-900 overflow-hidden text-white {isFullscreen ? 'fullscreen-mode' : ''}">
  <!-- Header Bar with Server Status -->
  {#if !isFullscreen}
  <header class="h-12 bg-gray-800/50 px-4 sm:px-6 flex items-center justify-between gap-2 shadow-xl z-10 border-b border-gray-800">
    <div class="flex items-center gap-3 min-w-0 shrink">
      <h1 class="font-light tracking-widest text-xl flex items-center gap-2 min-w-0 shrink">
        <span class=" bg-clip-text bg-gradient-to-r from-gray-200 to-slate-6000">Video Trimmer</span>
      </h1>
      <SettingsDropdown
        {outputDirectory}
        {generateOutputFilename}
        {hardwareAccelerationEnabled}
        {popupNotificationsEnabled}
        {chooseOutputDirectory}
        {clearOutputDirectory}
        {setGenerateOutputFilename}
        {setHardwareAccelerationEnabled}
        {setPopupNotificationsEnabled}
        {openCompressionPresetModal}
      />
    </div>
    
    <div class="flex items-center gap-2 sm:gap-4 min-w-0 shrink-0">
      {#if controlsEnabled && !isFullscreen && !sidebarsInMainRow}
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="px-2.5 py-1.5 sm:px-3 rounded-lg text-sm font-medium transition-all focus:outline-none duration-200 border border-gray-600/50 {showTracksOverlay ? 'bg-slate-600 text-white' : 'bg-slate-700/60  focus:outline-none text-slate-200 hover:bg-slate-600/80'}"
            aria-expanded={showTracksOverlay}
            aria-controls="tracks-panel"
            onclick={() => {
              showTrimOverlay = false;
              showTracksOverlay = !showTracksOverlay;
            }}
          >
            Tracks
          </button>
          <button
            type="button"
            class="px-2.5 py-1.5 sm:px-3 focus:outline-none rounded-lg text-sm font-medium transition-all duration-200 border border-gray-600/50 {showTrimOverlay ? 'bg-slate-600 text-white' : 'bg-slate-700/60 text-slate-200 focus:outline-none hover:bg-slate-600/80'}"
            aria-expanded={showTrimOverlay}
            aria-controls="trim-panel"
            onclick={() => {
              showTracksOverlay = false;
              showTrimOverlay = !showTrimOverlay;
            }}
          >
            Trim
          </button>
        </div>
      {/if}
      <button
        onclick={navigateToLibrary}
        class="px-3 sm:px-4 py-1.5 bg-gray-600/60 hover:bg-gray-500/60 rounded-lg text-sm font-medium transition-all duration-200 shrink-0"
      >
        <span class="hidden sm:inline">Library (Ctrl+1)</span>
        <span class="sm:hidden">Library</span>
      </button>
      
      <div class="{serverStatusClass} px-3 sm:px-4 py-1.5 rounded-full text-sm font-medium flex items-center gap-2 max-w-[40vw] sm:max-w-none truncate">
        {serverStatusMessage}
      </div>
    </div>
  </header>
  {/if}

  <!-- Main Content Area: video is flex-1; sidebars are in-row only when wide, else slide-overs (no horizontal scroll) -->
  <div class="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
    {#if controlsEnabled && !isFullscreen && !sidebarsInMainRow && (showTracksOverlay || showTrimOverlay)}
      <div
        class="fixed inset-x-0 top-12 bottom-0 z-40 bg-black/50"
        role="presentation"
        aria-hidden="true"
        onclick={closeSidebarOverlays}
      ></div>
    {/if}
    <!-- Track Management Panel (LEFT) -->
    {#if controlsEnabled && !isFullscreen}
      <TrackList
        {tracks}
        {activeTrackId}
        {draggedOverTrackId}
        {sidebarsInMainRow}
        {showTracksOverlay}
        {addTrack}
        addTrackFromLibrary={() => openLibraryPicker('add')}
        {handleFileChangeForNewTrack}
        {setActiveTrack}
        {handleTrackMouseDown}
        {handleKeyboardShortcuts}
        {removeTrack}
      />
    {/if}

    <!-- Video Preview Panel (CENTER) -->
    <VideoPreview>
      {#if !controlsEnabled && !isRestoringLibrarySelection}
        <!-- File Upload Area - Shown when no video is loaded -->
        <div 
          class="min-h-0 flex-1 flex flex-col items-center justify-center gap-6 p-8 bg-gray-950/50 relative {isDragOver ? 'drag-over-area' : ''}"
          role="button"
          tabindex="0"
          aria-label="Drag and drop video files here or click to select"
          ondragenter={handleDragEnter}
          ondragleave={handleDragLeaveFile}
          ondragover={handleDragOverFile}
          ondrop={handleFileDrop}
        >
          {#if isDragOver}
            <FileDropOverlay
              title="Drop your video files here"
              subtitle="Multiple files supported"
            />
          {/if}
          
          <div class="w-24 h-24 rounded-full bg-gray-800/20 flex items-center justify-center border-2 border-gray-700/30 shadow-lg shadow-gray-900/10">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-12 h-12 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 4v16M17 4v16M3 8h18M3 16h18" />
              </svg>
          </div>
          <div class="text-center max-w-lg">
            <h2 class="text-2xl font-light mb-2 text-slate-100">Get Started</h2>
            <p class="text-slate-300 mb-3">Drag & drop video files or click to select</p>
            <p class="text-sm text-slate-400 mb-6">Multiple video files supported</p>
            <input
              type="file"
              id="videoFile"
              class="hidden"
              accept="video/*"
              multiple
              onchange={handleFileChange}
            >
              <button
                type="button"
                onclick={() => chooseVideoFiles('videoFile')}
                class="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-slate-600 to-gray-700 rounded-lg cursor-pointer text-white font-medium transition-all duration-200 hover:translate-y-[-2px]"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /> 
                </svg>
                Select Video Files
              </button>
          </div>
        </div>
      {:else if controlsEnabled}
        <!-- Video Player Area -->
        <div class="flex-1 min-h-0 min-w-0 flex flex-col p-4 overflow-hidden bg-gray-950/50 focus:outline-none">
          <!-- File Selection Button -->
          {#if !isFullscreen}
          <div class="mb-2 flex min-w-0 flex-col gap-2 shrink-0">
            <div class="flex min-w-0 items-center justify-between gap-2">
              <h2 class="min-w-0 flex-1 truncate text-lg font-light text-slate-200">{activeVideoName}</h2>
              <input
                type="file"
                id="newVideoFile"
                class="hidden"
                accept="video/*"
                onchange={handleFileChangeForReplacement}
              >
              <div class="relative flex shrink-0 rounded-lg bg-slate-600/70 text-white shadow-md">
                <button
                  type="button"
                  onclick={() => runChangeVideoSource(preferredChangeVideoSource)}
                  title="Change video from {preferredChangeVideoSource === 'file' ? 'File Manager' : 'Library'}"
                  class="inline-flex items-center gap-1 rounded-l-lg px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/10"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Change Video
                </button>
                <button
                  type="button"
                  onclick={() => showChangeVideoMenu = !showChangeVideoMenu}
                  aria-label="Choose how to change the video"
                  aria-expanded={showChangeVideoMenu}
                  class="flex w-9 shrink-0 items-center justify-center rounded-r-lg border-l border-white/20 transition-colors hover:bg-white/10"
                >
                  <svg class="h-4 w-4 transition-transform {showChangeVideoMenu ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {#if showChangeVideoMenu}
                  <div class="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-slate-600/50 bg-slate-800 shadow-xl">
                    {#each [{ source: 'file' as const, label: 'From File Manager' }, { source: 'library' as const, label: 'From Library' }] as option}
                      <div class="flex items-center hover:bg-slate-700">
                        <button
                          type="button"
                          class="min-w-0 flex-1 px-3 py-2 text-left text-sm text-slate-100"
                          onclick={() => runChangeVideoSource(option.source)}
                        >
                          {option.label}
                        </button>
                        <button
                          type="button"
                          class="mr-1 rounded p-2 transition-colors hover:bg-slate-600 {preferredChangeVideoSource === option.source ? 'text-amber-400' : 'text-slate-400'}"
                          aria-label="{preferredChangeVideoSource === option.source ? 'Preferred' : 'Set'} {option.label} as preferred"
                          aria-pressed={preferredChangeVideoSource === option.source}
                          title="{preferredChangeVideoSource === option.source ? 'Preferred option' : 'Make this the preferred option'}"
                          onclick={() => setPreferredChangeVideoSource(option.source)}
                        >
                          <svg class="h-4 w-4" viewBox="0 0 24 24" fill={preferredChangeVideoSource === option.source ? 'currentColor' : 'none'} stroke="currentColor" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z" />
                          </svg>
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium">
              <div class="flex items-center">
                <span class="mr-1 text-slate-400">Size:</span>
                <span class="text-white">
                  {#if activeTrackId}
                    {@const activeTrack = tracks.find(t => t.id === activeTrackId)}
                    {#if activeTrack?.videoFile}
                      {(activeTrack.videoFile.size / (1024 * 1024)).toFixed(1)} MB
                    {:else if activeTrack?.filePath}
                      {@const fileSizeBytes = activeTrack.fileSizeBytes ?? 0}
                      {#if fileSizeBytes > 0}
                        {(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
                      {:else}
                        -
                      {/if}
                    {:else}
                      -
                    {/if}
                  {:else}
                    -
                  {/if}
                </span>
              </div>
              <div class="flex items-center">
                <span class="mr-1 text-slate-400">Duration:</span>
                <span class="text-white">{totalDuration}</span>
              </div>
              <div class="flex items-center">
                <span class="mr-1 text-slate-400">Trim:</span>
                <span class="text-white">{trimDuration}</span>
              </div>
            </div>
          </div>
          {/if}
          
          <!-- Video Container -->
          <div 
            class="relative min-h-0 flex-1 rounded-xl focus:outline-none overflow-hidden  flex items-center justify-center {isDragOver ? 'drag-over-area' : ''}"
            role="button"
            tabindex="0"
            aria-label="Video player area - drag and drop video files to add new tracks"
            ondragenter={handleDragEnter}
            ondragleave={handleDragLeaveFile}
            ondragover={handleDragOverFile}
            ondrop={handleFileDrop}
          >
            {#if isDragOver}
              <FileDropOverlay
                title="Add more video files"
                subtitle="Drop here to add new tracks"
                iconClass="w-16 h-30"
              />
            {/if}
            <video
              bind:this={videoPlayer}
              class="max-h-full max-w-full w-auto h-auto object-contain rounded-xl transition-opacity duration-100 {isVideoTransitioning ? 'opacity-0' : 'opacity-100'}"
              playsinline
              preload="auto"
              style="transform: translateZ(0); -webkit-transform: translateZ(0);"
              onloadedmetadata={() => {
                if (videoPlayer) {
                  duration = videoPlayer.duration;
                  if (!tracks.find(t => t.id === activeTrackId)?.endTimeManuallySet) {
                    endTime = formatTime(duration);
                    saveTrackState();
                  }
                }
              }}
              ontimeupdate={() => {
                if (videoPlayer) {
                  handlePlayerTimeUpdate(videoPlayer);
                }
              }}
              onclick={() => {
                safeVideoOperation((player) => {
                  if (player.paused) {
                    player.play();
                  } else {
                    player.pause();
                  }
                });
              }}
              onplay={() => {
                isPlaying = true;
              }}
              onpause={() => {
                isPlaying = false;
              }}
              onvolumechange={() => {
                if (videoPlayer) {
                  volume = videoPlayer.volume;
                  saveTrackState();
                }
              }}
            >
              <track kind="captions" src="" label="No captions available" />
              Your browser does not support video tag.
            </video>
            {#if transitionFrame}
              <img
                src={transitionFrame}
                alt=""
                aria-hidden="true"
                class="pointer-events-none absolute max-h-full max-w-full w-auto h-auto object-contain rounded-xl"
              />
            {/if}
            {#each Object.entries(preloadedTrackSources) as [trackId, src] (trackId)}
              <video
                src={src}
                preload="metadata"
                muted
                playsinline
                aria-hidden="true"
                class="pointer-events-none absolute h-px w-px opacity-0"
              ></video>
            {/each}
          </div>

          <!-- Video Controls -->
          <div class="mt-2 shrink-0 bg-gray-800/40 backdrop-blur-sm rounded-xl p-4 shadow-lg border border-gray-700/30" >
            <!-- Playback Controls (PLAY BUTTON) -->
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-3">
                <button
                  onclick={() => {
                    safeVideoOperation((player) => {
                      if (player.paused) {
                        player.play();
                      } else {
                        playFromStartRequest++;
                        player.pause();
                      }
                    });
                  }}
                  class="w-8 h-8 bg-gray-600/60 hover:bg-gray-500/60 rounded-full flex items-center justify-center shadow-md transition-colors focus:outline-none"
                  disabled={!controlsEnabled} 
                >
                  {#if isPlaying}
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"></path></svg>               
                  {:else}
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"></path></svg>
                  {/if}
                </button>
                
                <!-- Volume Control -->
                <div class="items-center relative flex items-center bg-gray-600/60 hover:bg-gray-700 transition-colors rounded-full w-fit group"
                  role="group"
                  aria-label="Volume control"
                  onmouseenter={openVolume}
                  onmouseleave={closeVolume}
                >

                  <button
                    onclick={() => {
                      safeVideoOperation((player) => {
                        if (player.volume > 0) {
                          volume = 0;
                        } else {
                          volume = 1;
                        }
                        player.volume = volume;
                        saveTrackState();
                      });
                    }}
                    class="w-8 h-8 flex items-center justify-center text-gray-300 hover:text-white transition-colors focus:outline-none rounded-xl"
                    disabled={!controlsEnabled}
                    
                  >
                    {#if volume > 0}
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z"></path></svg>
                    {:else}
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256"><path d="M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm101.66-61.3a8,8,0,0,1-11.32,11.32L216,139.31l-18.34,18.35a8,8,0,0,1-11.32-11.32L204.69,128l-18.35-18.34a8,8,0,0,1,11.32-11.32L216,116.69l18.34-18.35a8,8,0,0,1,11.32,11.32L227.31,128Z"></path></svg>                 
                    {/if}
                  </button>
                  
                    <div 
                      class="overflow-hidden transition-all duration-200 ease-out"
                      style="width: {showVolume ? '120px' : '0px'}; opacity: {showVolume ? '1' : '0'}">
                      <div class="pl-4 pr-2 py-3 flex items-center">

                        <input  
                          type="range"
                          min="0"
                          max="1"
                          step="0.1"
                          tabindex="-1"
                          aria-label="Volume Slider"
                          aria-valuenow={volume}
                          bind:value={volume}
                          oninput={() => {
                            safeVideoOperation((player) => {
                              player.volume = volume;
                              saveTrackState();
                            });
                          }}
                          onchange={(e) => {
                            const target = e.currentTarget as HTMLInputElement;
                            target.blur();
                          }}
                          onpointerup={(e) => {
                            const target = e.currentTarget as HTMLInputElement;
                            target.blur();
                          }}
                          class="volume-slider focus:outline-none w-fit group"
                        />
                      </div>
                    </div>                      
                </div>

                <div class="text-sm font-mono text-slate-200">
                  {formatTime(timelineUiTime)} / {totalDuration}
                </div>
              </div>

              <button
              onclick={toggleFullscreen}
              class="absolute top-4 right-4 p-2 bg-gray-800/80 hover:bg-gray-700/80 rounded-lg text-white transition-all duration-200 shadow-lg backdrop-blur-sm border border-gray-700/30"
              disabled={!controlsEnabled}
              aria-label="Toggle Fullscreen"
            >
              {#if isFullscreen}
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9V4.5 M9 9H4.5 M15 9V4.5 M15 9H19.5 M9 15V19.5 M9 15H4.5 M15 15V19.5 M15 15H19.5" />
                </svg>
              {:else}
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4 m0 0h4 M4 4l5 5 M20 8V4 m0 0h-4 M20 4l-5 5 M4 16v4 m0 -1h4 M4 20l5-5 M20 16v4 m0 0h-4 M20 20l-5-5" clip-rule="evenodd" />
                </svg>
              {/if}
            </button>
            </div>

            <Timeline
              {timelineUiTime}
              {timelineUiPercent}
              {duration}
              {startPercent}
              {endPercent}
              {trimPercent}
              {startTime}
              {endTime}
              {startTimeSeconds}
              {endTimeSeconds}
              {isDraggingStart}
              {isDraggingEnd}
              onTimelineMouseDown={handleTimelinePlayheadMouseDown}
              onStartMarkerMouseDown={handleStartMarkerMouseDown}
              onEndMarkerMouseDown={handleEndMarkerMouseDown}
              onKeydown={handleKeyboardShortcuts}
            />
          </div>
        </div>
      {/if}
    </VideoPreview>

    <!-- Controls Panel (RIGHT) -->
    {#if controlsEnabled && !isFullscreen}
      <TrimPanel
        {controlsEnabled}
        {sidebarsInMainRow}
        {showTrimOverlay}
        bind:startTime
        bind:endTime
        {selectedCompressionMode}
        {compressionModes}
        {expectedOutputSize}
        {selectedTrackCount}
        tracksLength={tracks.length}
        {downloadEnabled}
        onStartTimeInput={handleStartTimeInput}
        onEndTimeInput={handleEndTimeInput}
        {setCurrentAsStart}
        {setCurrentAsEnd}
        {playFromStart}
        {setCompressionMode}
        {openCompressionPresetModal}
        {toggleCompressionPresetHidden}
        {deleteCompressionPreset}
        downloadTrimmedVideo={requestTrimmedVideo}
      />
    {/if}
  </div>
  <StatusToast show={popupNotificationsEnabled && showStatus} message={statusMessage} type={statusType} />
</div>

<LoadingOverlay
  {showLoadingOverlay}
  {circularProgressOffset}
  {progressPercent}
  {loadingTitle}
  {loadingMessage}
  {isProcessing}
  {currentJobId}
  {completedOutput}
  onCancel={cancelCurrentJob}
  onOpenLocation={openCompletedOutputLocation}
  onClose={closeCompletedOutput}
/>

<OutputOptionsModal
  open={showOutputOptions}
  {outputDirectory}
  {outputFilename}
  {generateOutputFilename}
  error={outputOptionsError}
  onChooseDirectory={chooseOutputDirectory}
  onFilenameChange={setOutputFilename}
  onGenerateOutputFilenameChange={setGenerateOutputFilename}
  onConfirm={confirmOutputOptions}
  onClose={() => {
    showOutputOptions = false;
    outputOptionsError = '';
  }}
/>

{#if popupNotificationsEnabled}
  <UploadQueue {uploadQueue} />
{/if}

<CompressionPresetModal
  open={compressionPresetModalOpen}
  editingPreset={editingCompressionPreset}
  saving={compressionPresetSaving}
  error={compressionPresetError}
  onClose={closeCompressionPresetModal}
  onSave={saveCompressionPreset}
/>

<style>
  .server-status {
    background-color: rgb(254 252 232 / 0.1);
    border-color: rgb(254 240 138 / 0.2);
    color: rgb(234 179 8);
  }
  
  .server-status.online {
    background-color: rgb(14 165 233 / 0.2);
    border-color: rgb(56 189 248 / 0.3);
    color: rgb(125 211 252);
  }
  
  .server-status.offline {
    background-color: rgba(244, 63, 93, 0.274);
    border-color: rgb(244 63 94 / 0.3);
    color: rgb(251 113 133);
  }

  /* Drag and drop area styling */
  .drag-over-area {
    transition: all 0.3s ease;
  }

  .volume-slider {
  width: 96px; /* w-24 */
  height: 5px;
  accent-color: rgb(212 212 216); /* gray-300 */
  background: rgb(63 63 70); /* zinc-700 */
  border-radius: 9999px;
  cursor: pointer;

  display: flex;
  align-items: center;
}

  /* Filled part (left of thumb) */
  .volume-slider::-webkit-slider-runnable-track {
    background: linear-gradient(to right, 
      rgb(212 212 216) var(--value-percent), 
      rgb(63 63 70) var(--value-percent)
    );
    height: 6px;
    border-radius: 9999px;
  }

  /* Thumb */
  .volume-slider::-webkit-slider-thumb {
    appearance: none;
    width: 5px;
    height: 5px;
    border-radius: 9999px;
    background: white;
    margin-top: -4px; /* centers thumb on 6px track */
  }


</style>
