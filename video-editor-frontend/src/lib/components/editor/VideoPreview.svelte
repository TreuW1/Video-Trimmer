<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="flex-1 min-w-0 min-h-0 flex flex-col h-full overflow-hidden focus:outline-none">
  {@render children()}
</div>

