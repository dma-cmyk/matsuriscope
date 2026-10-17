<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useMediaStore } from '../stores';
import StatsBar from '../components/StatsBar.vue';
import FilterBar from '../components/FilterBar.vue';
import MediaGrid from '../components/MediaGrid.vue';
import BoardCollector from '../components/BoardCollector.vue';

const props = defineProps<{ fixedType?: string }>();
const media = useMediaStore();

function applyRoute() {
  const target = props.fixedType === 'favorite' ? 'favorite' : 'all';
  if (media.typeFilter !== target) {
    media.setFilter({ typeFilter: target }); // 内部でrefreshされる
  } else {
    void media.refresh();
  }
}

onMounted(applyRoute);
watch(() => props.fixedType, applyRoute);
</script>

<template>
  <v-container fluid class="pa-4" style="max-width: 1400px">
    <StatsBar class="mb-4" />
    <BoardCollector class="mb-4" />
    <FilterBar class="mb-4" />
    <MediaGrid />
  </v-container>
</template>
