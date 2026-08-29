<script lang="ts">
  let {
    open,
    outputDirectory,
    outputFilename,
    generateOutputFilename,
    outputExtension = 'mp4',
    error = '',
    onChooseDirectory,
    onFilenameChange,
    onGenerateOutputFilenameChange,
    onConfirm,
    onClose
  }: {
    open: boolean;
    outputDirectory: string;
    outputFilename: string;
    generateOutputFilename: boolean;
    outputExtension?: 'mp4' | 'm4a';
    error?: string;
    onChooseDirectory: () => void;
    onFilenameChange: (filename: string) => void;
    onGenerateOutputFilenameChange: (enabled: boolean) => void;
    onConfirm: () => void;
    onClose: () => void;
  } = $props();
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/90 p-4 backdrop-blur-md">
    <div class="w-full max-w-lg rounded-2xl border border-gray-400/20 bg-gradient-to-b from-gray-900 to-gray-800 p-6 shadow-2xl">
      <h2 class="text-xl font-semibold text-white">Choose output</h2>
      <p class="mt-1 text-sm text-slate-400">Select where this trimmed {outputExtension === 'm4a' ? 'audio' : 'video'} will be saved and set its file name.</p>

      <div class="mt-5 space-y-4">
        <div class:opacity-50={generateOutputFilename}>
          <label class="mb-1.5 block text-sm font-medium text-slate-200" for="output-folder">Output folder</label>
          <div class="flex gap-2">
            <input
              id="output-folder"
              value={outputDirectory}
              readonly
              placeholder="Default outputs folder"
              class="min-w-0 flex-1 rounded-lg border border-gray-600/60 bg-gray-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
            />
            <button
              type="button"
              onclick={onChooseDirectory}
              class="rounded-lg border border-slate-500/40 bg-slate-700/70 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-600/80"
            >
              Browse
            </button>
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium text-slate-200" for="output-filename">File name</label>
          <input
            id="output-filename"
            value={outputFilename}
            oninput={(event) => onFilenameChange(event.currentTarget.value)}
            disabled={generateOutputFilename}
            placeholder={outputExtension === 'm4a' ? 'trimmed-audio.m4a' : 'trimmed-video.mp4'}
            autocomplete="off"
            class="w-full rounded-lg border border-gray-600/60 bg-gray-950/50 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-slate-400 focus:outline-none"
          />
          <p class="mt-1 text-xs text-slate-500">{outputExtension.toUpperCase()} is added automatically if you leave off the extension.</p>
        </div>

        <label class="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-700/50 bg-gray-950/30 p-3">
          <input
            type="checkbox"
            checked={generateOutputFilename}
            onchange={(event) => onGenerateOutputFilenameChange(event.currentTarget.checked)}
            class="mt-0.5 rounded border-gray-600 bg-gray-800 text-slate-500 focus:ring-slate-500"
          />
          <span>
            <span class="block text-sm font-medium text-slate-200">Generate a unique file name automatically</span>
            <span class="mt-0.5 block text-xs text-slate-500">Skip the filename question on future trims and use a generated name. Can be changed under Output in the settings menu</span>
          </span>
        </label>

        {#if error}
          <p class="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-sm text-red-300">{error}</p>
        {/if}
      </div>

      <div class="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onclick={onClose}
          class="rounded-lg border border-gray-600/50 bg-gray-800/60 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-gray-700/70"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={onConfirm}
          class="rounded-lg bg-slate-600 px-4 py-2 text-sm font-medium text-white shadow-md transition-colors hover:bg-slate-500"
        >
          {outputExtension === 'm4a' ? 'Start extraction' : 'Start trimming'}
        </button>
      </div>
    </div>
  </div>
{/if}
