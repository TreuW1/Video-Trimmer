<script lang="ts">
  import { untrack, type Snippet } from 'svelte';

  let {
    title,
    value,
    fallbackValue = 'Not set',
    description = '',
    initiallyOpen = false,
    children
  }: {
    title: string;
    value?: string;
    fallbackValue?: string;
    description?: string;
    initiallyOpen?: boolean;
    children?: Snippet;
  } = $props();

  let isOpen = $state(untrack(() => initiallyOpen));
  let contentId = $derived(`setting-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
  let displayValue = $derived(value?.trim() || fallbackValue);
</script>

<div class="overflow-hidden rounded-lg border border-gray-700/30 bg-gray-900/30 shadow-md">
  <button
    type="button"
    class="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-gray-800/40"
    aria-expanded={isOpen}
    aria-controls={contentId}
    onclick={() => {
      isOpen = !isOpen;
    }}
  >
    <div class="min-w-0 flex-1">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-medium uppercase tracking-wide text-slate-300">{title}</h3>
        <span class="shrink-0 text-slate-400 transition-transform {isOpen ? 'rotate-180' : ''}" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19 9-7 7-7-7" />
          </svg>
        </span>
      </div>
      <div class="mt-1 truncate text-xs text-slate-300" title={displayValue}>{displayValue}</div>
      {#if description}
        <div class="mt-1 text-xs text-slate-500">{description}</div>
      {/if}
    </div>
  </button>

  {#if isOpen}
    <div id={contentId} class="border-t border-gray-700/30 p-3">
      {@render children?.()}
    </div>
  {/if}
</div>
