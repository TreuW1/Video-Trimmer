<script lang="ts">
  import { onMount } from 'svelte';
  import type { VideoTrack } from '$lib/types/editor';

  type TrackSource = 'file' | 'library';
  const ADD_TRACK_SOURCE_KEY = 'trimmerPreferredAddTrackSource';

  let {
    tracks,
    activeTrackId,
    draggedOverTrackId,
    sidebarsInMainRow,
    showTracksOverlay,
    addTrack,
    addTrackFromLibrary,
    handleFileChangeForNewTrack,
    setActiveTrack,
    handleTrackMouseDown,
    handleKeyboardShortcuts,
    removeTrack
  }: {
    tracks: VideoTrack[];
    activeTrackId: string | null;
    draggedOverTrackId: string | null;
    sidebarsInMainRow: boolean;
    showTracksOverlay: boolean;
    addTrack: () => void;
    addTrackFromLibrary: () => void;
    handleFileChangeForNewTrack: (event: Event) => void;
    setActiveTrack: (trackId: string) => void;
    handleTrackMouseDown: (trackId: string, event: MouseEvent) => void;
    handleKeyboardShortcuts: (event: KeyboardEvent) => void;
    removeTrack: (trackId: string) => void;
  } = $props();

  let showAddTrackMenu = $state(false);
  let preferredAddTrackSource = $state<TrackSource>('file');

  onMount(() => {
    const savedSource = localStorage.getItem(ADD_TRACK_SOURCE_KEY);
    if (savedSource === 'file' || savedSource === 'library') {
      preferredAddTrackSource = savedSource;
    }
  });

  function runAddTrackSource(source: TrackSource): void {
    showAddTrackMenu = false;
    if (source === 'library') {
      addTrackFromLibrary();
    } else {
      addTrack();
    }
  }

  function setPreferredAddTrackSource(source: TrackSource): void {
    preferredAddTrackSource = source;
    localStorage.setItem(ADD_TRACK_SOURCE_KEY, source);
  }

  function trackName(track: VideoTrack): string {
    return track.videoFile
      ? track.videoFile.name
      : track.filePath
        ? track.filePath.split(/[\\/]/).pop() || 'video.mp4'
        : 'No video loaded';
  }
</script>

<div
  id="tracks-panel"
  class="bg-gray-800/30 backdrop-blur-sm focus:outline-none flex flex-col overflow-hidden border-gray-700/20 {sidebarsInMainRow
    ? 'w-64 shrink-0 border-r'
    : showTracksOverlay
      ? 'fixed z-[45] top-12 bottom-0 left-0 w-64 max-w-[90vw] border-r shadow-2xl'
      : 'hidden'}"
>
  <div class="p-4 border-b border-gray-700/20">
    <h3 class="text-lg font-light text-slate-200 mb-4">Tracks</h3>
    <div class="relative flex w-full rounded-lg bg-gradient-to-r from-slate-600 to-gray-700 text-white shadow-md">
      <button
        type="button"
        onclick={() => runAddTrackSource(preferredAddTrackSource)}
        title="Add track from {preferredAddTrackSource === 'file' ? 'File Manager' : 'Library'}"
        class="min-w-0 flex-1 rounded-l-lg p-2 font-medium transition-colors hover:bg-white/10 focus:outline-none"
      >
        Add Track
      </button>
      <button
        type="button"
        onclick={() => showAddTrackMenu = !showAddTrackMenu}
        aria-label="Choose how to add a track"
        aria-expanded={showAddTrackMenu}
        class="flex w-10 shrink-0 items-center justify-center rounded-r-lg border-l border-white/20 transition-colors hover:bg-white/10 focus:outline-none"
      >
        <svg class="h-4 w-4 transition-transform {showAddTrackMenu ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {#if showAddTrackMenu}
        <div class="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-slate-600/50 bg-slate-800 shadow-xl">
          {#each [{ source: 'file' as const, label: 'From File Manager' }, { source: 'library' as const, label: 'From Library' }] as option}
            <div class="flex items-center hover:bg-slate-700">
              <button
                type="button"
                class="min-w-0 flex-1 px-3 py-2 text-left text-sm text-slate-100"
                onclick={() => runAddTrackSource(option.source)}
              >
                {option.label}
              </button>
              <button
                type="button"
                class="mr-1 rounded p-2 transition-colors hover:bg-slate-600 {preferredAddTrackSource === option.source ? 'text-amber-400' : 'text-slate-400'}"
                aria-label="{preferredAddTrackSource === option.source ? 'Preferred' : 'Set'} {option.label} as preferred"
                aria-pressed={preferredAddTrackSource === option.source}
                title="{preferredAddTrackSource === option.source ? 'Preferred option' : 'Make this the preferred option'}"
                onclick={() => setPreferredAddTrackSource(option.source)}
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill={preferredAddTrackSource === option.source ? 'currentColor' : 'none'} stroke="currentColor" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z" />
                </svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <input
      type="file"
      id="addTrackFileInput"
      class="hidden"
      accept="video/*"
      multiple
      onchange={handleFileChangeForNewTrack}
    />
  </div>

  <div class="flex-1 focus:outline-none overflow-auto p-4 space-y-2">
    {#each tracks as track, index (track.id)}
      <div
        class="track-item p-3 focus:outline-none rounded-lg border transition-all duration-200 cursor-pointer {activeTrackId === track.id ? 'bg-gradient-to-r from-blue-800/70 focus:outline-none to-indigo-700/70 border-blue-500/50' : 'border-gray-600/30 hover:border-gray-500/50 focus:outline-none bg-gray-900/30 hover:bg-gray-800/40'} {draggedOverTrackId === track.id ? 'drag-over' : ''}"
        data-track-id={track.id}
        onclick={() => setActiveTrack(track.id)}
        onmousedown={(event) => handleTrackMouseDown(track.id, event)}
        onkeydown={handleKeyboardShortcuts}
        role="button"
        tabindex="0"
      >
        <div class="flex items-center focus:outline-none justify-between mb-2">
          <div class="flex items-center gap-2">
            <input type="checkbox" bind:checked={track.selected} onclick={(event) => event.stopPropagation()} class="mr-2" aria-label="Select track to combine with other tracks" />
            <div class="drag-handle">
              <svg class="w-4 h-4 text-gray-400 cursor-grab" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16" />
              </svg>
            </div>
            <span class="text-sm font-medium text-white">Track {index + 1}</span>
          </div>
          <button
            onclick={(event) => {
              event.stopPropagation();
              removeTrack(track.id);
            }}
            class="text-gray-400 hover:text-red-400 transition-colors"
            aria-label="Remove Track"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 truncate text-xs text-gray-400">{trackName(track)}</div>
          {#if track.audioDetached}
            <span class="shrink-0 rounded border border-amber-400/25 bg-amber-950/25 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-300">Audio detached</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  :global(.track-item.dragging) {
    opacity: 1;
    cursor: grabbing;
  }

  :global(.track-item.drag-over) {
    border-color: rgb(59 130 246 / 0.5);
    background-color: rgb(30 64 175 / 0.3);
    transform: translateY(2px);
  }

  :global(.track-item) {
    transition: transform 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
    user-select: none;
  }

  .drag-handle {
    cursor: grab;
    padding: 4px;
    border-radius: 4px;
    transition: background-color 0.2s ease;
  }

  .drag-handle:hover {
    background-color: rgba(255, 255, 255, 0.1);
  }

  .drag-handle:active {
    cursor: grabbing;
  }
</style>
