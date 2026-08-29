<script lang="ts">
  import type { CompressionPreset } from '$lib/types/editor';

  let {
    controlsEnabled,
    sidebarsInMainRow,
    showTrimOverlay,
    startTime = $bindable(),
    endTime = $bindable(),
    selectedCompressionMode,
    compressionModes,
    audioOnlyOutput,
    expectedOutputSize,
    selectedTrackCount,
    tracksLength,
    downloadEnabled,
    onStartTimeInput,
    onEndTimeInput,
    setCurrentAsStart,
    setCurrentAsEnd,
    playFromStart,
    setCompressionMode,
    openCompressionPresetModal,
    toggleCompressionPresetHidden,
    deleteCompressionPreset,
    downloadTrimmedVideo
  }: {
    controlsEnabled: boolean;
    sidebarsInMainRow: boolean;
    showTrimOverlay: boolean;
    startTime: string;
    endTime: string;
    selectedCompressionMode: string;
    compressionModes: CompressionPreset[];
    audioOnlyOutput: boolean;
    expectedOutputSize: string;
    selectedTrackCount: number;
    tracksLength: number;
    downloadEnabled: boolean;
    onStartTimeInput: () => void;
    onEndTimeInput: () => void;
    setCurrentAsStart: () => void;
    setCurrentAsEnd: () => void;
    playFromStart: () => void;
    setCompressionMode: (mode: string) => void;
    openCompressionPresetModal: (preset?: CompressionPreset) => void;
    toggleCompressionPresetHidden: (id: string) => void;
    deleteCompressionPreset: (preset: CompressionPreset) => void;
    downloadTrimmedVideo: () => void;
  } = $props();

  let selectedPreset = $derived(compressionModes.find((mode) => mode.id === selectedCompressionMode));
  let managePresets = $state(false);
  let visibleCompressionModes = $derived(compressionModes.filter((mode) => !(mode as CompressionPreset & { hidden?: boolean }).hidden));
  let shownManagedModes = $derived(compressionModes.filter((mode) => !(mode as CompressionPreset & { hidden?: boolean }).hidden));
  let hiddenManagedModes = $derived(compressionModes.filter((mode) => (mode as CompressionPreset & { hidden?: boolean }).hidden));
  let customManagedModes = $derived(compressionModes.filter((mode) => !mode.builtIn));

  function presetSummary(mode: CompressionPreset): string {
    if (mode.processingStrategy === 'sizeTarget') {
      const size = mode.sizeLabel ?? `~${mode.sizeLimitMB ?? mode.targetSizeMB} MB`;
      return mode.alwaysCompress ? `${size} • always compress` : size;
    }
    if (mode.processingStrategy === 'bitrateTarget') return `${mode.targetSizePercent}% of source`;
    if (mode.rateControl === 'constantBitrate') return `${mode.bitrateKbps ?? '-'} kbps`;
    if (mode.rateControl === 'constantQp') return `QP ${mode.qp ?? '-'}`;
    if (mode.rateControl === 'constantQuality') return `CRF ${mode.crf ?? '-'}`;
    return mode.processingStrategy;
  }
</script>

<div
  id="trim-panel"
  class="relative bg-gray-800/30 flex flex-col border-gray-700/20 {managePresets ? 'overflow-visible' : 'overflow-hidden'} {sidebarsInMainRow
    ? 'w-80 shrink-0 border-l'
    : showTrimOverlay
      ? 'fixed z-[45] top-12 bottom-0 right-0 w-80 max-w-[90vw] border-l shadow-2xl'
      : 'hidden'}"
>
  {#if controlsEnabled}
    <div class="flex-1  overflow-auto p-4">
      <div class="mb-5">
        <div class="flex flex-col mb-3">
          <label for="startTimeInput" class="font-medium text-teal-300 mb-1 text-xs uppercase tracking-wider">Start Time</label>
          <input
            type="text"
            id="startTimeInput"
            bind:value={startTime}
            oninput={onStartTimeInput}
            class="p-2 bg-gray-800/50 border border-teal-500/30 rounded-lg text-sm text-white focus:outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-400/30 shadow-md"
            placeholder="00:00:00.00"
          />
        </div>
        <div class="flex flex-col">
          <label for="endTimeInput" class="font-medium text-amber-300 mb-1 text-xs uppercase tracking-wider">End Time</label>
          <input
            type="text"
            id="endTimeInput"
            bind:value={endTime}
            oninput={onEndTimeInput}
            class="p-2 bg-gray-800/50 border border-amber-500/30 rounded-lg text-sm text-white focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-400/30 shadow-md"
            placeholder="00:00:00.00"
          />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2 mb-5">
        <button
          onclick={setCurrentAsStart}
          disabled={!controlsEnabled}
          class="p-2 focus:outline-none border rounded-lg font-medium cursor-pointer text-xs uppercase bg-gradient-to-r from-teal-600/40 to-teal-500/40 border-teal-500/50 text-teal-300 hover:bg-teal-500/30 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
        >
          Set Start (S)
        </button>

        <button
          onclick={setCurrentAsEnd}
          disabled={!controlsEnabled}
          class="p-2 focus:outline-none border rounded-lg font-medium cursor-pointer text-xs uppercase bg-gradient-to-r from-amber-600/40 to-amber-500/40 border-amber-500/50 text-amber-300 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
        >
          Set End (E)
        </button>
      </div>

      <button
        onclick={playFromStart}
        disabled={!controlsEnabled}
        class="w-full focus:outline-none p-3 mb-5 rounded-lg font-medium cursor-pointer transition-all duration-200 text-sm shadow-md bg-gradient-to-r from-slate-600/50 to-gray-700/50 border border-gray-700/30 text-white hover:from-slate-500/50 hover:to-gray-600/50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Play from Start (P)
      </button>

      <div class="mb-5">
        {#if audioOnlyOutput}
          <div class="rounded-lg border border-amber-400/25 bg-amber-950/20 p-3">
            <h3 class="text-sm font-medium uppercase tracking-wide text-amber-200">Audio-only output</h3>
            <p class="mt-1 text-xs text-amber-100/60">Video compression is bypassed while extracting M4A audio.</p>
          </div>
        {:else}
          <div class="mb-3 flex items-center justify-between gap-2">
            <h3 class="font-medium text-slate-300 text-sm uppercase tracking-wide">Compression Mode</h3>
            <div class="flex gap-1">
              <button
                type="button"
                class="rounded-md focus:outline-none border border-gray-600/40 px-2 py-1 text-xs text-slate-300 hover:bg-gray-800/60"
                onclick={() => openCompressionPresetModal()}
              >
                New
              </button>
              <button
                type="button"
                class="rounded-md focus:outline-none border border-gray-600/40 px-2 py-1 text-xs {managePresets ? 'bg-slate-600 text-white' : 'text-slate-300 hover:bg-gray-800/60'}"
                onclick={() => {
                  managePresets = !managePresets;
                }}
              >
                Manage
              </button>
            </div>
          </div>
          <div class="space-y-2">
            {#each visibleCompressionModes as mode}
              <div class="rounded-lg border text-sm shadow-md {selectedCompressionMode === mode.id ? 'bg-gradient-to-r from-blue-800/70 to-indigo-700/70 border-blue-500/50' : 'border-gray-600/30 bg-gray-900/30 hover:bg-gray-800/40'}">
                <button
                  type="button"
                  class="w-full p-2 text-left focus:outline-none"
                  onclick={() => setCompressionMode(mode.id)}
                >
                  <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0 font-medium text-white">{mode.name}</div>
                    <div class="shrink-0 text-[11px] text-slate-400">{mode.builtIn ? 'Guide' : 'Custom'}</div>
                  </div>
                  <div class="text-xs text-blue-300 mt-0.5">{mode.description}</div>
                  <div class="mt-1 text-[11px] text-slate-400">{presetSummary(mode)}</div>
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      {#if expectedOutputSize && !audioOnlyOutput}
        <div class="p-3 bg-gradient-to-r from-gray-900/50 to-blue-900/50 rounded-lg mb-5 text-center border border-gray-700/30 shadow-lg">
          <span class="text-xs text-blue-300 font-medium">Expected output size:</span>
          <span class="text-white font-semibold text-lg">{expectedOutputSize}</span>
          {#if selectedPreset && selectedPreset.processingStrategy !== 'directCopy'}
            <div class="text-gray-300 text-xs mt-1">({selectedPreset?.name ?? selectedCompressionMode} compression)</div>
          {/if}
          {#if selectedTrackCount > 1}
            <div class="text-gray-300 text-xs mt-1">Combined from {selectedTrackCount} tracks</div>
          {/if}
        </div>
      {/if}
    </div>

    {#if tracksLength > 1}
      {#if selectedTrackCount > 1}
        <div class="text-xs text-blue-300 text-center mb-2">
          Selected clips ({selectedTrackCount}) will be combined in order.
        </div>
      {:else}
        <div class="text-xs text-gray-400 text-center mb-2">
          Select multiple tracks to combine them, or just trim the active track.
        </div>
      {/if}
    {/if}

    <div class="p-3 border-t border-gray-700/20 bg-gray-900/30">
      <button
        onclick={downloadTrimmedVideo}
        disabled={!downloadEnabled}
        class="w-full p-3 rounded-lg font-semibold focus:outline-none cursor-pointer text-sm uppercase tracking-wider bg-gradient-to-r from-slate-600 to-gray-700 text-white hover:from-slate-500 hover:to-gray-600 hover:shadow-lg hover:shadow-gray-700/20 hover:translate-y-[-2px] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:translate-y-0"
      >
        {audioOnlyOutput
          ? selectedTrackCount > 1
            ? 'Combine & Extract Audio'
            : 'Extract Audio'
          : selectedTrackCount > 1
            ? 'Combine & Trim Videos'
            : 'Trim video'}
      </button>
    </div>

    {#if managePresets && !audioOnlyOutput}
      <div class="fixed inset-0 z-[70] pointer-events-none">
        <button
          type="button"
          aria-label="Close compression mode manager"
          class="absolute inset-0 cursor-default pointer-events-auto"
          onclick={() => {
            managePresets = false;
          }}
        ></button>
        <section
          class="absolute top-16 bottom-5 left-3 right-3 overflow-hidden rounded-lg border border-gray-600/50 bg-gray-900/95 shadow-2xl shadow-black/40 backdrop-blur-md pointer-events-auto lg:left-auto lg:right-[21rem] lg:w-[min(720px,calc(100vw-23rem))]"
          aria-label="Compression mode manager"
        >
          <div class="flex items-center justify-between gap-3 border-b border-gray-700/60 px-4 py-3">
            <div class="min-w-0">
              <h3 class="text-sm font-semibold uppercase tracking-wide text-slate-200">Manage Compression Modes</h3>
              <p class="mt-0.5 text-xs text-slate-400">Choose what appears in the right-side mode list.</p>
            </div>
            <button
              type="button"
              class="rounded-md border border-gray-600/50 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-gray-800"
              onclick={() => {
                managePresets = false;
              }}
            >
              Close
            </button>
          </div>

          <div class="h-full overflow-auto p-4 pb-20">
            <div class="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <div class="space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-300">Shown Modes</h4>
                  <span class="rounded bg-gray-800 px-2 py-0.5 text-[11px] text-slate-400">{shownManagedModes.length}</span>
                </div>
                <div class="grid gap-2">
                  {#each shownManagedModes as mode}
                    <div class="rounded-lg border border-gray-700/60 bg-gray-950/40 p-3 text-sm">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex items-center gap-2">
                            <div class="truncate font-medium text-white">{mode.name}</div>
                            <span class="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">{mode.builtIn ? 'Guide' : 'Custom'}</span>
                          </div>
                          <div class="mt-1 line-clamp-2 text-xs text-blue-300">{mode.description}</div>
                          <div class="mt-1 text-[11px] text-slate-400">{presetSummary(mode)}</div>
                        </div>
                        <div class="flex shrink-0 gap-1">
                          <button
                            type="button"
                            class="rounded-md px-2 py-1 text-xs text-slate-200 hover:bg-gray-800"
                            onclick={() => toggleCompressionPresetHidden(mode.id)}
                          >
                            Hide
                          </button>
                          {#if !mode.builtIn}
                            <button
                              type="button"
                              class="rounded-md px-2 py-1 text-xs text-slate-200 hover:bg-gray-800"
                              onclick={() => openCompressionPresetModal(mode)}
                            >
                              Edit
                            </button>
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>

              <div class="space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-300">Hidden Modes</h4>
                  <span class="rounded bg-gray-800 px-2 py-0.5 text-[11px] text-slate-400">{hiddenManagedModes.length}</span>
                </div>
                <div class="grid gap-2">
                  {#if hiddenManagedModes.length === 0}
                    <div class="rounded-lg border border-dashed border-gray-700/70 bg-gray-950/30 p-3 text-xs text-slate-500">
                      No hidden modes.
                    </div>
                  {/if}
                  {#each hiddenManagedModes as mode}
                    <div class="rounded-lg border border-gray-800/70 bg-gray-950/30 p-3 text-sm opacity-80">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex items-center gap-2">
                            <div class="truncate font-medium text-white">{mode.name}</div>
                            <span class="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">{mode.builtIn ? 'Guide' : 'Custom'}</span>
                          </div>
                          <div class="mt-1 line-clamp-2 text-xs text-blue-300">{mode.description}</div>
                          <div class="mt-1 text-[11px] text-slate-400">{presetSummary(mode)}</div>
                        </div>
                        <button
                          type="button"
                          class="shrink-0 rounded-md px-2 py-1 text-xs text-slate-200 hover:bg-gray-800"
                          onclick={() => toggleCompressionPresetHidden(mode.id)}
                        >
                          Show
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            </div>

            <div class="mt-4 space-y-3 border-t border-gray-800 pt-4">
              <div class="flex items-center justify-between gap-2">
                <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-300">Custom Presets</h4>
                <button
                  type="button"
                  class="rounded-md border border-gray-600/50 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-gray-800"
                  onclick={() => openCompressionPresetModal()}
                >
                  New Preset
                </button>
              </div>
              <div class="grid gap-2 md:grid-cols-2">
                {#if customManagedModes.length === 0}
                  <div class="rounded-lg border border-dashed border-gray-700/70 bg-gray-950/30 p-3 text-xs text-slate-500 md:col-span-2">
                    No custom presets yet.
                  </div>
                {/if}
                {#each customManagedModes as mode}
                  {@const hidden = (mode as CompressionPreset & { hidden?: boolean }).hidden}
                  <div class="rounded-lg border border-gray-700/60 bg-gray-950/40 p-3 text-sm {hidden ? 'opacity-60' : ''}">
                    <div class="font-medium text-white">{mode.name}</div>
                    <div class="mt-1 text-xs text-blue-300">{mode.description}</div>
                    <div class="mt-2 flex flex-wrap gap-1">
                      <button
                        type="button"
                        class="rounded-md px-2 py-1 text-xs text-slate-200 hover:bg-gray-800"
                        onclick={() => openCompressionPresetModal(mode)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-2 py-1 text-xs text-slate-200 hover:bg-gray-800"
                        onclick={() => toggleCompressionPresetHidden(mode.id)}
                      >
                        {hidden ? 'Show' : 'Hide'}
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-2 py-1 text-xs text-red-200 hover:bg-red-950/50"
                        onclick={() => deleteCompressionPreset(mode)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </section>
      </div>
    {/if}
  {:else}
    <div class="flex-1 flex items-center justify-center text-gray-500 text-sm p-6 text-center">
      <p>Select a video to enable trimming controls</p>
    </div>
  {/if}
</div>
