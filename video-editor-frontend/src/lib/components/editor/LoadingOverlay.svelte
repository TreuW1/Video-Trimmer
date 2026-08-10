<script lang="ts">
  let {
    showLoadingOverlay,
    circularProgressOffset,
    progressPercent,
    loadingTitle,
    loadingMessage,
    isProcessing,
    currentJobId,
    completedOutput,
    onCancel,
    onOpenLocation,
    onClose
  }: {
    showLoadingOverlay: boolean;
    circularProgressOffset: number;
    progressPercent: number;
    loadingTitle: string;
    loadingMessage: string;
    isProcessing: boolean;
    currentJobId: string | null;
    completedOutput: {
      outputSize: string;
      outputPath: string;
      filename: string;
      timeTaken: string;
      preset: string;
    } | null;
    onCancel: () => void;
    onOpenLocation: () => void;
    onClose: () => void;
  } = $props();
</script>

{#if showLoadingOverlay}
  <div class="fixed inset-0 bg-gray-950/90 backdrop-blur-md flex justify-center items-center z-50">
    <div class="bg-gradient-to-b from-gray-900 to-gray-800 p-8 rounded-2xl text-center max-w-md shadow-2xl border border-gray-400/20">
      <div class="w-24 h-24 mx-auto mb-6 relative">
        <svg viewBox="0 0 80 80" class="w-full h-full -rotate-90">
          <defs>
            <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:#94A3B8" />
              <stop offset="100%" style="stop-color:#64748B" />
            </linearGradient>
          </defs>
          <circle class="fill-none stroke-gray-800 stroke-4" cx="40" cy="40" r="35" />
          <circle
            class="fill-none stroke-4 stroke-linecap-round"
            style="stroke: url(#gradient); stroke-dasharray: 219.9; stroke-dashoffset: {circularProgressOffset};"
            cx="40"
            cy="40"
            r="35"
          />
        </svg>
        <div class="absolute inset-0 flex items-center justify-center text-base font-bold text-white">
          {Math.round(progressPercent)}%
        </div>
      </div>

      <h3 class="text-xl font-semibold mb-4 text-white">{loadingTitle}</h3>
      {#each loadingMessage.split('\n') as line}
        <p class="text-slate-300 mb-1">{line}</p>
      {/each}

      {#if isProcessing && currentJobId}
        <button
          onclick={onCancel}
          class="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium shadow-md"
        >
          Cancel Processing
        </button>
      {:else if completedOutput}
        <div class="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-4 text-left">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <div class="text-xs font-medium uppercase tracking-wide text-emerald-300/80">Final output size</div>
              <div class="mt-1 text-xl font-semibold text-white">{completedOutput.outputSize} MB</div>
            </div>
            <div>
              <div class="text-xs font-medium uppercase tracking-wide text-emerald-300/80">Time taken</div>
              <div class="mt-1 text-xl font-semibold text-white">{completedOutput.timeTaken}</div>
            </div>
          </div>
          <div class="mt-4 border-t border-emerald-500/15 pt-3">
            <div class="text-xs font-medium uppercase tracking-wide text-emerald-300/80">Preset used</div>
            <div class="mt-1 text-sm font-medium text-slate-200">{completedOutput.preset}</div>
          </div>
          <div class="mt-3 truncate text-sm text-slate-400" title={completedOutput.outputPath}>{completedOutput.filename}</div>
        </div>
        <div class="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onclick={onClose}
            class="rounded-lg border border-gray-600/50 bg-gray-800/60 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-gray-700/70"
          >
            Close
          </button>
          <button
            type="button"
            onclick={onOpenLocation}
            class="rounded-lg bg-slate-600 px-4 py-2 text-sm font-medium text-white shadow-md transition-colors hover:bg-slate-500"
          >
            Open file location
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

