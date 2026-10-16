<script setup lang="ts">
import { computed } from 'vue';
import { useMetaStore } from '../stores';

const meta = useMetaStore();

const cards = computed(() => {
  const s = meta.stats;
  return [
    { label: '収集スレッド', value: s?.threads ?? '-', icon: 'mdi-forum', color: '#22d3ee' },
    { label: '画像', value: (s?.images ?? 0) + (s?.gifs ?? 0), icon: 'mdi-image', color: '#34d399' },
    { label: '動画', value: s?.videos ?? '-', icon: 'mdi-play-circle', color: '#a855f7' },
    { label: 'お気に入り', value: s?.favorites ?? '-', icon: 'mdi-star', color: '#fbbf24' },
  ];
});

const lastJobText = computed(() => {
  const j = meta.stats?.lastJob;
  if (!j) return '未収集';
  if (j.status === 'running') return '収集中…';
  const d = new Date(j.started_at * 1000);
  return `前回: ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 新規${j.media_new}件`;
});
</script>

<template>
  <div class="stats-grid">
    <v-card v-for="c in cards" :key="c.label" class="stat-card" color="surface" flat>
      <div class="d-flex align-center ga-3 pa-4">
        <v-avatar :color="c.color" size="42" variant="tonal">
          <v-icon :icon="c.icon" />
        </v-avatar>
        <div>
          <div class="text-caption text-medium-emphasis">{{ c.label }}</div>
          <div class="text-h5 font-weight-bold">{{ c.value }}</div>
        </div>
      </div>
    </v-card>
    <v-card class="stat-card" color="surface" flat>
      <div class="d-flex align-center ga-3 pa-4">
        <v-avatar color="#38bdf8" size="42" variant="tonal">
          <v-icon icon="mdi-sync" />
        </v-avatar>
        <div>
          <div class="text-caption text-medium-emphasis">自動更新</div>
          <div class="text-body-1 font-weight-bold">{{ meta.stats?.collectIntervalMinutes ?? 30 }}分ごと</div>
          <div class="text-caption text-medium-emphasis">{{ lastJobText }}</div>
        </div>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.stat-card {
  border: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 12px;
}
</style>
