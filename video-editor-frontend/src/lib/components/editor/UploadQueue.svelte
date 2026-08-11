<script lang="ts">
  import type { UploadQueueItem } from '$lib/types/editor';
  import { getCompletedUploadQueueCount, getUploadQueueFileName } from '$lib/stores/useUploadQueue';

  let { uploadQueue }: { uploadQueue: UploadQueueItem[] } = $props();

  let completedCount = $derived(getCompletedUploadQueueCount(uploadQueue));
</script>

{#if uploadQueue.length > 0}
  <div class="fixed bottom-4 right-4 bg-gradient-to-r from-slate-800 to-gray-900 p-4 rounded-xl shadow-xl z-40 border border-gray-700/30 animate-fadeIn max-w-sm">
    <div class="flex items-center justify-between mb-2">
      <h3 class="font-semibold text-white text-sm">Upload Queue</h3>
      <span class="text-xs text-slate-400">{completedCount}/{uploadQueue.length}</span>
    </div>

    <div class="trimmer-scrollbar space-y-2 max-h-64 overflow-y-auto">
      {#each uploadQueue as item (item.trackId)}
        <div class="bg-gray-800/50 rounded-lg p-2 border border-gray-700/30">
          <div class="flex items-center gap-2">
            <div class="flex-shrink-0">
              {#if item.status === 'uploading'}
                <div class="w-8 h-8 relative">
                  <svg viewBox="0 0 80 80" class="w-full h-full -rotate-90">
                    <circle class="fill-none stroke-gray-700 stroke-3" cx="40" cy="40" r="35" />
                    <circle
                      class="fill-none stroke-3 stroke-linecap-round transition-all duration-300"
                      style="stroke: #64748B; stroke-dasharray: 251.2; stroke-dashoffset: {251.2 - (item.progress / 100) * 251.2};"
                      cx="40"
                      cy="40"
                      r="35"
                    />
                  </svg>
                  <div class="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">
                    {Math.round(item.progress)}
                  </div>
                </div>
              {:else if item.status === 'completed'}
                <div class="w-8 h-8 rounded-full bg-green-600/20 flex items-center justify-center">
                  <svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              {:else if item.status === 'skipped'}
                <div class="w-8 h-8 rounded-full bg-blue-600/20 flex items-center justify-center">
                  <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              {:else if item.status === 'failed'}
                <div class="w-8 h-8 rounded-full bg-red-600/20 flex items-center justify-center">
                  <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
              {:else}
                <div class="w-8 h-8 rounded-full bg-gray-600/20 flex items-center justify-center">
                  <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              {/if}
            </div>

            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-white truncate">{getUploadQueueFileName(item.file, item.filePath)}</p>
              <p class="text-xs text-slate-400">
                {#if item.status === 'uploading'}
                  Uploading... {Math.round(item.progress)}%
                {:else if item.status === 'completed'}
                  Uploaded
                {:else if item.status === 'skipped'}
                  Already exists
                {:else if item.status === 'failed'}
                  Failed: {item.error || 'Unknown error'}
                {:else}
                  Waiting...
                {/if}
              </p>
            </div>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}
