<script lang="ts">
  let {
    show,
    message,
    type
  }: {
    show: boolean;
    message: string;
    type: string;
  } = $props();

  const successClasses =
    'bg-gradient-to-r from-green-600 to-emerald-600 text-white border-green-400/30';
  const errorClasses = 'bg-gradient-to-r from-red-600 to-rose-600 text-white border-red-400/30';
</script>

{#if show}
  <div
    class="fixed bottom-4 left-1/2 transform -translate-x-1/2 p-4 rounded-lg font-medium shadow-xl z-50 text-sm max-w-md backdrop-blur-sm border animate-fadeIn {type ===
    'success'
      ? successClasses
      : errorClasses}"
  >
    {message}
  </div>
{/if}

<style>
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .animate-fadeIn {
    animation: fadeIn 0.3s ease-out forwards;
  }
</style>
