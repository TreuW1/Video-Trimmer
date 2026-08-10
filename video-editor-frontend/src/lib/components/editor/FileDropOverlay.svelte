<script lang="ts">
  let {
    title,
    subtitle,
    iconClass = 'w-16 h-16'
  }: {
    title: string;
    subtitle: string;
    iconClass?: string;
  } = $props();
</script>

<div
  class="absolute inset-0 bg-blue-600/20 border-2 border-dashed border-blue-400 rounded-xl flex items-center justify-center backdrop-blur-sm z-10"
>
  <div class="text-center">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="{iconClass} text-blue-400 mx-auto mb-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.5"
        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
      />
    </svg>
    <p class="text-xl font-medium text-blue-300">{title}</p>
    <p class="text-sm text-blue-400 mt-1">{subtitle}</p>
  </div>
</div>
