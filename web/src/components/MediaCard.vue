<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MediaItem } from '../api';
import { useMediaStore } from '../stores';

const props = defineProps<{ item: MediaItem }>();
const emit = defineEmits<{ open: [item: MediaItem] }>();
const media = useMediaStore();

const TYPE_BADGE: Record<string, { label: string; color: string; icon: string }> = {
  image: { label: '画像', color: '#22d3ee', icon: 'mdi-image' },
  gif: { label: 'GIF', color: '#34d399', icon: 'mdi-file-gif-box' },
  video: { label: '動画', color: '#a855f7', icon: 'mdi-play' },
  youtube: { label: '動画', color: '#a855f7', icon: 'mdi-youtube' },
  twitter: { label: 'X投稿', color: '#38bdf8', icon: 'mdi-twitter' },
  other: { label: 'リンク', color: '#94a3b8', icon: 'mdi-link' },
};

const badge = computed(() => TYPE_BADGE[props.item.type] ?? TYPE_BADGE['other']!);
const imgError = ref(false);

const thumbUrl = computed(() => {
  if (imgError.value) return null;
  if (props.item.thumbnail_url) return props.item.thumbnail_url;
  if (props.item.type === 'image' || props.item.type === 'gif') return props.item.url;
  return null;
});

const relativeTime = computed(() => {
  const diff = Date.now() / 1000 - props.item.first_seen_at;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return `${Math.floor(diff / 86400)}日前`;
});
</script>

<template>
  <v-card class="media-card" color="surface" flat @click="emit('open', item)">
    <div class="thumb-wrap">
      <v-img
        v-if="thumbUrl"
        :src="thumbUrl"
        :aspect-ratio="4 / 3"
        cover
        class="thumb"
        loading="lazy"
        @error="imgError = true"
      >
        <template #placeholder>
          <div class="thumb-placeholder"><v-icon icon="mdi-loading" class="spin" /></div>
        </template>
      </v-img>
      <div v-else class="thumb-fallback d-flex align-center justify-center">
        <v-icon :icon="badge.icon" size="40" color="medium-emphasis" />
      </div>
      <v-chip class="type-badge" size="x-small" :style="{ background: badge.color }" label>
        <v-icon start :icon="badge.icon" size="12" />{{ badge.label }}
      </v-chip>
      <div class="ikioi-chip">🔥 {{ Math.round(item.ikioi).toLocaleString() }}</div>
    </div>
    <div class="card-body pa-3">
      <div class="thread-title">{{ item.thread_title }}</div>
      <div class="meta d-flex align-center ga-2 text-caption text-medium-emphasis mt-1">
        <span class="board-tag">{{ item.board_name }}</span>
        <span>レス {{ item.res_count.toLocaleString() }}</span>
        <span>{{ relativeTime }}</span>
        <span v-if="item.occ_count > 1" class="text-secondary">{{ item.occ_count }}スレ</span>
      </div>
      <div class="d-flex align-center mt-1">
        <v-spacer />
        <v-btn
          icon
          size="x-small"
          variant="text"
          :color="item.favorite === 1 ? 'warning' : 'medium-emphasis'"
          @click.stop="media.toggleFavorite(item)"
        >
          <v-icon :icon="item.favorite === 1 ? 'mdi-star' : 'mdi-star-outline'" />
        </v-btn>
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.media-card {
  border: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.media-card:hover {
  transform: translateY(-2px);
  border-color: rgba(34, 211, 238, 0.5);
}
.thumb-wrap {
  position: relative;
  background: #0d1220;
}
.thumb-fallback {
  aspect-ratio: 4 / 3;
  background: linear-gradient(135deg, #0d1220 0%, #1a2233 100%);
}
.type-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  color: #0b0f1a;
  font-weight: 700;
}
.ikioi-chip {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.65);
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 0.72rem;
  font-weight: 600;
  color: #fbbf24;
}
.thread-title {
  font-size: 0.82rem;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.2em;
}
.board-tag {
  color: #22d3ee;
}
.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.spin {
  animation: spin 1.2s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
