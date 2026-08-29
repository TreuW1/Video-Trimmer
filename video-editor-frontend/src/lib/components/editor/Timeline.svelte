<script lang="ts">
  import type { AudioMuteRange, AudioOutputMode } from '$lib/types/editor';

  const HANDLE_HALF_WIDTH_PX = 4;
  const PLAYHEAD_WIDTH_PX = 4;
  const END_HANDLE_LEFT_OFFSET_PX = -1;
  const END_STOP_PLAYHEAD_OFFSET_PX = END_HANDLE_LEFT_OFFSET_PX - PLAYHEAD_WIDTH_PX;
  const END_STOP_TIME_TOLERANCE_SECONDS = 0.01;
  const DEFAULT_MUTE_RANGE_SECONDS = 1;
  const MIN_MUTE_RANGE_SECONDS = 0.05;

  type MuteRangeDragMode = 'move' | 'start' | 'end';
  type MuteRangeDrag = {
    index: number;
    mode: MuteRangeDragMode;
    pointerId: number;
    originClientX: number;
    originRange: AudioMuteRange;
    previewRange: AudioMuteRange;
    waveformWidth: number;
  };

  let {
    timelineUiTime,
    timelineUiPercent,
    duration,
    startPercent,
    endPercent,
    trimPercent,
    startTime,
    endTime,
    startTimeSeconds,
    endTimeSeconds,
    isDraggingStart,
    isDraggingEnd,
    waveformPeaks,
    waveformLoading,
    waveformHasAudio,
    audioDetached,
    audioWaveformHidden,
    audioWaveformGloballyHidden,
    audioOutputMode,
    audioMuteRanges,
    onTimelineMouseDown,
    onStartMarkerMouseDown,
    onEndMarkerMouseDown,
    onKeydown,
    setAudioDetached,
    setAudioWaveformHidden,
    setAudioWaveformsHidden,
    setAudioOutputMode,
    setAudioMuteRanges,
  }: {
    timelineUiTime: number;
    timelineUiPercent: number;
    duration: number;
    startPercent: number;
    endPercent: number;
    trimPercent: number;
    startTime: string;
    endTime: string;
    startTimeSeconds: number;
    endTimeSeconds: number;
    isDraggingStart: boolean;
    isDraggingEnd: boolean;
    waveformPeaks: number[];
    waveformLoading: boolean;
    waveformHasAudio: boolean | null;
    audioDetached: boolean;
    audioWaveformHidden: boolean;
    audioWaveformGloballyHidden: boolean;
    audioOutputMode: AudioOutputMode;
    audioMuteRanges: AudioMuteRange[];
    onTimelineMouseDown: (event: MouseEvent) => void;
    onStartMarkerMouseDown: (event: MouseEvent) => void;
    onEndMarkerMouseDown: (event: MouseEvent) => void;
    onKeydown: (event: KeyboardEvent) => void;
    setAudioDetached: (detached: boolean) => void;
    setAudioWaveformHidden: (hidden: boolean) => void;
    setAudioWaveformsHidden: (hidden: boolean) => void;
    setAudioOutputMode: (mode: AudioOutputMode) => void;
    setAudioMuteRanges: (ranges: AudioMuteRange[]) => void;
  } = $props();

  let audioMenuOpen = $state(false);
  let audioMenuX = $state(0);
  let audioMenuY = $state(0);
  let audioMenuDialog = $state<HTMLDialogElement>();
  let muteRangeStart = $state('');
  let muteRangeEnd = $state('');
  let muteRangeError = $state('');
  let waveformTrack = $state<HTMLDivElement>();
  let muteRangeDrag = $state<MuteRangeDrag | null>(null);

  const clampPercent = (percent: number) => Math.max(0, Math.min(100, percent));
  const timelineSafeLeft = (percent: number, offsetPx = 0) =>
    `clamp(0%, calc(${clampPercent(percent)}% + ${offsetPx}px), calc(100% - ${PLAYHEAD_WIDTH_PX}px))`;

  function formatTimelineTime(seconds: number): string {
    const totalMilliseconds = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
    const hours = Math.floor(totalMilliseconds / 3_600_000);
    const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
    const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  }

  function parseTimelineTime(value: string): number {
    const parts = value.trim().split(':');
    if (parts.length > 3 || parts.length === 0) return Number.NaN;
    const numericParts = parts.map(Number);
    if (numericParts.some((part) => !Number.isFinite(part) || part < 0)) return Number.NaN;
    return numericParts.reduce((total, part) => total * 60 + part, 0);
  }

  let playheadVisualLeft = $derived.by(() => {
    if (isDraggingStart) return timelineSafeLeft(startPercent, HANDLE_HALF_WIDTH_PX);
    if (isDraggingEnd) {
      const offset = END_HANDLE_LEFT_OFFSET_PX - HANDLE_HALF_WIDTH_PX - PLAYHEAD_WIDTH_PX;
      return timelineSafeLeft(endPercent, offset);
    }
    if (Math.abs(timelineUiTime - endTimeSeconds) <= END_STOP_TIME_TOLERANCE_SECONDS) {
      return timelineSafeLeft(endPercent, END_STOP_PLAYHEAD_OFFSET_PX);
    }
    return timelineSafeLeft(timelineUiPercent);
  });

  function scaleDenseWaveform(peaks: number[]): number[] {
    const normalized = peaks.map((peak) => Math.max(0, Math.min(1, peak)));
    const audible = normalized.filter((peak) => peak > 0).sort((a, b) => a - b);
    if (audible.length === 0) return normalized;

    // Dense, consistently loud clips otherwise fill almost the entire lane.
    // Increasing the curve only when the median is high lowers the body of the
    // waveform while leaving genuine peaks near full height.
    const median = audible[Math.floor((audible.length - 1) * 0.5)];
    const density = Math.max(0, Math.min(1, (median - 0.68) / 0.25));
    const exponent = 1 + density * 1.75;
    return exponent === 1 ? normalized : normalized.map((peak) => Math.pow(peak, exponent));
  }

  let displayWaveformPeaks = $derived(scaleDenseWaveform(waveformPeaks));

  function setMuteDraftFromPlayback(): void {
    const playbackTime = Math.max(0, Math.min(duration, timelineUiTime));
    muteRangeStart = formatTimelineTime(playbackTime);
    muteRangeEnd = formatTimelineTime(
      Math.min(duration, playbackTime + DEFAULT_MUTE_RANGE_SECONDS)
    );
    muteRangeError = '';
  }

  function positionAudioMenu(clientX: number, clientY: number): void {
    const menuWidth = 288;
    const menuHeight = 560;
    audioMenuX = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, clientX));
    audioMenuY = Math.max(8, Math.min(window.innerHeight - menuHeight - 8, clientY));
    if (!muteRangeStart && !muteRangeEnd) {
      setMuteDraftFromPlayback();
    }
    audioMenuOpen = true;
    if (!audioMenuDialog?.open) audioMenuDialog?.showModal();
  }

  function openAudioMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    positionAudioMenu(event.clientX, event.clientY);
  }

  function openAudioMenuAtPlayback(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setMuteDraftFromPlayback();
    positionAudioMenu(event.clientX, event.clientY);
  }

  function openAudioMenuFromButton(event: MouseEvent): void {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    positionAudioMenu(rect.right - 288, rect.bottom + 6);
  }

  function closeAudioMenu(): void {
    audioMenuOpen = false;
    if (audioMenuDialog?.open) audioMenuDialog.close();
  }

  function closeAudioMenuFromBackdrop(event: MouseEvent): void {
    const rect = audioMenuDialog?.getBoundingClientRect();
    if (
      rect &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    ) {
      closeAudioMenu();
    }
  }

  function chooseAudioMode(mode: AudioOutputMode): void {
    setAudioOutputMode(mode);
    if (mode !== 'keep') setAudioDetached(true);
  }

  function toggleAudioDetached(): void {
    const detached = !audioDetached;
    setAudioDetached(detached);
    if (!detached && audioOutputMode === 'extract') setAudioOutputMode('keep');
  }

  function addAudioMuteRange(): void {
    const startTime = parseTimelineTime(muteRangeStart);
    const endTime = parseTimelineTime(muteRangeEnd);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      muteRangeError = 'Enter valid times in HH:MM:SS.mmm format.';
      return;
    }
    if (startTime < 0 || endTime <= startTime || endTime > duration + 0.001) {
      muteRangeError = `Choose a range between 0 and ${formatTimelineTime(duration)}.`;
      return;
    }

    setAudioMuteRanges([...audioMuteRanges, { startTime, endTime }]);
    setAudioDetached(true);
    muteRangeError = '';
    muteRangeStart = formatTimelineTime(endTime);
    muteRangeEnd = formatTimelineTime(Math.min(duration, endTime + 1));
    closeAudioMenu();
  }

  function removeAudioMuteRange(index: number): void {
    setAudioMuteRanges(audioMuteRanges.filter((_, rangeIndex) => rangeIndex !== index));
  }

  function beginMuteRangeDrag(
    event: PointerEvent,
    index: number,
    mode: MuteRangeDragMode
  ): void {
    if (event.button !== 0 || !waveformTrack || duration <= 0) return;
    const range = audioMuteRanges[index];
    const waveformWidth = waveformTrack.getBoundingClientRect().width;
    if (!range || waveformWidth <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    muteRangeDrag = {
      index,
      mode,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      originRange: { ...range },
      previewRange: { ...range },
      waveformWidth
    };
  }

  function handleMuteRangePointerMove(event: PointerEvent): void {
    const drag = muteRangeDrag;
    if (!drag || event.pointerId !== drag.pointerId || duration <= 0) return;
    event.preventDefault();

    const deltaSeconds = ((event.clientX - drag.originClientX) / drag.waveformWidth) * duration;
    const originalLength = drag.originRange.endTime - drag.originRange.startTime;
    let startTime = drag.originRange.startTime;
    let endTime = drag.originRange.endTime;

    if (drag.mode === 'move') {
      startTime = Math.max(0, Math.min(duration - originalLength, startTime + deltaSeconds));
      endTime = startTime + originalLength;
    } else if (drag.mode === 'start') {
      startTime = Math.max(0, Math.min(endTime - MIN_MUTE_RANGE_SECONDS, startTime + deltaSeconds));
    } else {
      endTime = Math.min(duration, Math.max(startTime + MIN_MUTE_RANGE_SECONDS, endTime + deltaSeconds));
    }

    muteRangeDrag = {
      ...drag,
      previewRange: { startTime, endTime }
    };
  }

  function finishMuteRangeDrag(event: PointerEvent): void {
    const drag = muteRangeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();

    const updatedRanges = audioMuteRanges.map((range, index) =>
      index === drag.index ? drag.previewRange : range
    );
    muteRangeDrag = null;
    setAudioMuteRanges(updatedRanges);
  }
</script>

<svelte:window
  onpointermove={handleMuteRangePointerMove}
  onpointerup={finishMuteRangeDrag}
  onpointercancel={finishMuteRangeDrag}
/>

<div class="relative" role="group" aria-label="Video and audio timeline">
  <div class="mb-1.5 focus:outline-none flex items-center justify-between gap-3">
    <div class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
      <span>Video</span>
      <span class="normal-case tracking-normal text-slate-600">Right-click for audio actions</span>
    </div>
    <div class="flex items-center gap-2">
      <div class="flex items-center gap-2 text-[12px] font-medium leading-none">
        <span class="text-teal-300">Start: {startTime}</span>
        <span class="text-amber-300">End: {endTime}</span>
      </div>
      <button
        type="button"
        class="flex focus:outline-none items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors {audioDetached ? 'border-amber-400/40 bg-amber-950/30 text-amber-200' : 'border-gray-600/50 bg-gray-900/60 text-slate-300 hover:bg-gray-800'}"
        onclick={openAudioMenuFromButton}
        aria-expanded={audioMenuOpen}
      >
        Audio
        {#if audioWaveformHidden}<span class="rounded bg-slate-400/15 px-1 text-[9px] uppercase">{audioWaveformGloballyHidden ? 'Globally hidden' : 'Hidden'}</span>{/if}
        {#if audioDetached}<span class="rounded bg-amber-400/15 px-1 text-[9px] uppercase">Detached</span>{/if}
        <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 9 6 6 6-6" /></svg>
      </button>
    </div>
  </div>

  <div
    class="timeline-container relative h-12 cursor-pointer overflow-hidden rounded-md border border-gray-700/20 bg-gray-950/70 shadow-inner"
    role="slider"
    tabindex="0"
    aria-label="Video timeline scrubber"
    aria-valuenow={Math.round(timelineUiTime)}
    aria-valuemin="0"
    aria-valuemax={Math.round(duration)}
    onmousedown={onTimelineMouseDown}
    oncontextmenu={openAudioMenuAtPlayback}
    onkeydown={onKeydown}
  >
    <div class="absolute top-0 z-30 h-full w-1 bg-red-500 shadow-lg" style="left: {playheadVisualLeft}">
      <div class="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 transform rounded-full bg-red-500 shadow-lg"></div>
    </div>

    <div class="absolute left-0 top-0 h-full bg-gray-600/20" style="width: {clampPercent(startPercent)}%"></div>
    <div class="absolute top-0 h-full bg-gray-600/20" style="left: {clampPercent(endPercent)}%; width: {Math.max(0, 100 - clampPercent(endPercent))}%"></div>

    <div
      class="absolute top-0 z-20 h-full w-2 cursor-grab rounded-l-xl bg-teal-300 shadow-lg focus:outline-none {isDraggingStart ? 'cursor-grabbing' : ''}"
      style="left: {clampPercent(startPercent)}%"
      role="slider"
      tabindex="0"
      aria-label="Start time marker"
      aria-valuenow={Math.round(startTimeSeconds * 1000)}
      onmousedown={onStartMarkerMouseDown}
      onkeydown={onKeydown}
    ></div>

    <div
      class="absolute top-0 z-20 h-full w-2 cursor-grab rounded-r-xl bg-amber-500 shadow-lg focus:outline-none {isDraggingEnd ? 'cursor-grabbing' : ''}"
      style="left: calc({clampPercent(endPercent)}% - 1px)"
      role="slider"
      tabindex="0"
      aria-label="End time marker"
      aria-valuenow={Math.round(endTimeSeconds * 1000)}
      onmousedown={onEndMarkerMouseDown}
      onkeydown={onKeydown}
    ></div>
  </div>

  {#if !audioWaveformHidden}
    <section
      class="audio-lane focus:outline-none relative mt-2 overflow-hidden rounded-md border transition-all {audioDetached
        ? 'border-amber-300/50 bg-amber-950/30 shadow-[0_0_0_1px_rgba(251,191,36,0.08)]'
        : 'border-cyan-300/35 bg-cyan-950/35 shadow-[0_0_0_1px_rgba(103,232,249,0.06)]'} {audioOutputMode === 'mute' ? 'opacity-55' : ''}"
      aria-label={audioDetached ? 'Detached audio track' : 'Attached audio waveform'}
      oncontextmenu={openAudioMenu}
    >
      <div class="relative h-14 rounded-md" bind:this={waveformTrack}>
      <div
        class="pointer-events-none absolute inset-y-0 border-x {audioDetached ? 'border-amber-200/20 bg-amber-300/[0.06]' : 'border-cyan-200/20 bg-cyan-300/[0.06]'}"
        style="left: {clampPercent(startPercent)}%; width: {Math.max(0, trimPercent)}%"
      ></div>
      <div class="pointer-events-none absolute inset-x-0 top-1/2 h-px {audioDetached ? 'bg-amber-200/15' : 'bg-cyan-200/15'}"></div>

      {#each audioMuteRanges as range, index}
        {@const displayedRange = muteRangeDrag?.index === index ? muteRangeDrag.previewRange : range}
        <div
          class="absolute inset-y-0 z-30 border-x border-red-200/80 bg-red-500/30 shadow-[0_0_8px_rgba(248,113,113,0.25)]"
          class:ring-1={muteRangeDrag?.index === index}
          class:ring-red-200={muteRangeDrag?.index === index}
          style="left: {clampPercent(duration > 0 ? (displayedRange.startTime / duration) * 100 : 0)}%; width: {clampPercent(duration > 0 ? ((displayedRange.endTime - displayedRange.startTime) / duration) * 100 : 0)}%"
          title={`Muted ${formatTimelineTime(displayedRange.startTime)} – ${formatTimelineTime(displayedRange.endTime)}`}
        >
          <button
            type="button"
            class="absolute inset-y-0 left-1.5 right-1.5 cursor-move touch-none focus:outline-none"
            aria-label={`Move muted portion ${index + 1}`}
            onpointerdown={(event) => beginMuteRangeDrag(event, index, 'move')}
          ></button>
          <button
            type="button"
            class="absolute inset-y-0 -left-1 z-10 w-3 cursor-ew-resize touch-none border-l-2 border-red-100/90 bg-gradient-to-r from-red-200/30 to-transparent focus:outline-none"
            aria-label={`Adjust start of muted portion ${index + 1}`}
            onpointerdown={(event) => beginMuteRangeDrag(event, index, 'start')}
          ></button>
          <button
            type="button"
            class="absolute inset-y-0 -right-1 z-10 w-3 cursor-ew-resize touch-none border-r-2 border-red-100/90 bg-gradient-to-l from-red-200/30 to-transparent focus:outline-none"
            aria-label={`Adjust end of muted portion ${index + 1}`}
            onpointerdown={(event) => beginMuteRangeDrag(event, index, 'end')}
          ></button>
        </div>
      {/each}

      {#if waveformLoading}
        <div class="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
      {:else if waveformHasAudio === false}
        <div class="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wider text-slate-500">No audio track</div>
      {:else if displayWaveformPeaks.length > 0}
        <svg class="absolute inset-0 z-10 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {#each displayWaveformPeaks as peak, index}
            {@const height = Math.max(5, peak * 90)}
            <rect
              x={(index / displayWaveformPeaks.length) * 100}
              y={50 - height / 2}
              width={(100 / displayWaveformPeaks.length) * 0.72}
              height={height}
              rx="0.1"
              fill={audioDetached ? '#fde68a' : '#a5f3fc'}
              fill-opacity={audioOutputMode === 'mute' ? 0.45 : 0.9}
            />
          {/each}
        </svg>
      {/if}

      <div class="audio-trim-mask pointer-events-none absolute left-0 top-0 z-20 h-full" style="width: {clampPercent(startPercent)}%"></div>
      <div class="audio-trim-mask pointer-events-none absolute top-0 z-20 h-full" style="left: {clampPercent(endPercent)}%; width: {Math.max(0, 100 - clampPercent(endPercent))}%"></div>
      <div class="pointer-events-none absolute top-0 z-30 h-full w-px bg-red-300/95 shadow-[0_0_4px_rgba(252,165,165,0.6)]" style="left: {playheadVisualLeft}"></div>
      </div>
    </section>
  {/if}

</div>

<dialog
  bind:this={audioMenuDialog}
  class="fixed focus:outline-none z-[81] m-0 w-72 overflow-y-auto rounded-xl border border-gray-600/60 bg-gray-900/98 p-3 text-left text-white shadow-2xl shadow-black/50 backdrop-blur-md"
  style="left: {audioMenuX}px; top: {audioMenuY}px; right: auto; bottom: auto; max-height: calc(100vh - 16px)"
  aria-label="Audio track settings"
  oncancel={(event) => {
    event.preventDefault();
    closeAudioMenu();
  }}
  onclose={() => (audioMenuOpen = false)}
  onclick={closeAudioMenuFromBackdrop}
>
  {#if audioMenuOpen}
    <div class="mb-3 flex items-center justify-between gap-2">
      <div>
        <div class="text-sm font-semibold text-white">Audio track</div>
        <div class="text-[11px] text-slate-500">Timeline display and output audio.</div>
      </div>
      <button class="rounded p-1 text-slate-400 hover:bg-gray-800 hover:text-white" onclick={closeAudioMenu} aria-label="Close audio menu">✕</button>
    </div>

    <button
      type="button"
      class="mb-2 focus:outline-none w-full rounded-lg border border-gray-700 bg-gray-950/40 px-3 py-2 text-left text-sm text-slate-200 hover:bg-gray-800"
      onclick={() => setAudioWaveformsHidden(!audioWaveformGloballyHidden)}
    >
      <span class="block font-medium">{audioWaveformGloballyHidden ? 'Show waveforms on all tracks' : 'Hide waveforms on all tracks'}</span>
      <span class="mt-0.5 block text-[11px] opacity-65">Global timeline display setting.</span>
    </button>

    <button
      type="button"
      class="mb-2 focus:outline-none w-full rounded-lg border border-gray-700 bg-gray-950/40 px-3 py-2 text-left text-sm text-slate-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-55"
      onclick={() => setAudioWaveformHidden(!audioWaveformHidden)}
      disabled={audioWaveformGloballyHidden}
    >
      <span class="block font-medium">{audioWaveformGloballyHidden ? 'Waveforms hidden globally' : audioWaveformHidden ? 'Show audio waveform' : 'Hide audio waveform'}</span>
      <span class="mt-0.5 block text-[11px] opacity-65">{audioWaveformGloballyHidden ? 'Use the global control above to show waveforms.' : audioWaveformHidden ? 'Restore this track’s audio lane.' : 'Remove this track’s audio lane.'}</span>
    </button>

    <button
      type="button"
      class="mb-3 w-full rounded-lg border px-3 py-2 text-left text-sm {audioDetached ? 'border-amber-400/30 bg-amber-950/20 text-amber-200' : 'border-gray-700 bg-gray-950/40 text-slate-200 hover:bg-gray-800'}"
      onclick={toggleAudioDetached}
      disabled={waveformHasAudio === false}
    >
      <span class="block font-medium">{audioDetached ? 'Attach audio to video' : 'Detach audio'}</span>
      <span class="mt-0.5 block text-[11px] opacity-65">{audioDetached ? 'Return to a single linked video lane.' : 'Create a separate editable audio lane.'}</span>
    </button>

    <div class="focus:outline-none grid grid-cols-2 gap-1.5">
      <button class="rounded-md px-2 py-2 text-xs {audioOutputMode === 'keep' ? 'bg-slate-600 text-white' : 'bg-gray-800/70 text-slate-300 hover:bg-gray-700'}" onclick={() => chooseAudioMode('keep')}>Keep audio</button>
      <button class="rounded-md px-2 py-2 text-xs {audioOutputMode === 'mute' ? 'bg-red-900/70 text-red-100' : 'bg-gray-800/70 text-slate-300 hover:bg-gray-700'}" onclick={() => chooseAudioMode(audioOutputMode === 'mute' ? 'keep' : 'mute')}>Mute</button>
      <button class="col-span-2 rounded-md px-2 py-2 text-xs {audioOutputMode === 'extract' ? 'bg-amber-700/70 text-white' : 'bg-gray-800/70 text-slate-300 hover:bg-gray-700'}" onclick={() => chooseAudioMode(audioOutputMode === 'extract' ? 'keep' : 'extract')}>Extract audio only (.m4a)</button>
    </div>

    <div class="mt-3 border-t border-gray-700/70 pt-3">
      <div class="mb-2">
        <div class="text-xs font-semibold uppercase tracking-wide text-slate-300">Mute a portion</div>
        <div class="mt-0.5 text-[11px] text-slate-500">Right-click the video timeline to use the playhead as Start, then drag the red waveform bar or either edge.</div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label class="text-[11px] text-slate-400">
          Start
          <input class="mt-1 w-full rounded border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-xs text-white focus:border-red-400 focus:outline-none" bind:value={muteRangeStart} />
        </label>
        <label class="text-[11px] text-slate-400">
          End
          <input class="mt-1 w-full rounded border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-xs text-white focus:border-red-400 focus:outline-none" bind:value={muteRangeEnd} />
        </label>
      </div>
      {#if muteRangeError}
        <div class="mt-2 text-[11px] text-red-300">{muteRangeError}</div>
      {/if}
      <button
        type="button"
        class="mt-2 w-full rounded-md bg-red-900/70 px-2 py-2 text-xs text-red-100 hover:bg-red-800/80 disabled:opacity-50"
        onclick={addAudioMuteRange}
        disabled={waveformHasAudio === false}
      >
        Add muted portion
      </button>

      {#if audioMuteRanges.length > 0}
        <div class="mt-2 max-h-24 space-y-1 overflow-auto">
          {#each audioMuteRanges as range, index}
            <div class="flex items-center justify-between gap-2 rounded bg-gray-950/45 px-2 py-1 text-[11px] text-slate-300">
              <span>{formatTimelineTime(range.startTime)} – {formatTimelineTime(range.endTime)}</span>
              <button type="button" class="shrink-0 text-red-300 hover:text-red-200" onclick={() => removeAudioMuteRange(index)}>Remove</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .timeline-container {
    user-select: none;
    -webkit-user-select: none;
    outline: none !important;
  }

  .timeline-container:focus {
    outline: none !important;
    box-shadow: none !important;
  }

  .timeline-container > div[role='slider'] {
    transform: translateX(-50%);
    cursor: grab;
  }

  .timeline-container > div[role='slider']:active {
    cursor: grabbing;
  }

  .audio-lane {
    background-image: linear-gradient(180deg, rgb(8 47 73 / 0.28), rgb(2 6 23 / 0.5));
  }

  .audio-trim-mask {
    background-color: rgb(2 6 23 / 0.28);
    background-image: repeating-linear-gradient(
      -45deg,
      transparent,
      transparent 5px,
      rgb(148 163 184 / 0.045) 5px,
      rgb(148 163 184 / 0.045) 10px
    );
  }

  dialog::backdrop {
    background: transparent;
  }
</style>
