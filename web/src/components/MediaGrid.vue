<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMediaStore } from '../stores';
import type { MediaItem } from '../api';
import MediaCard from './MediaCard.vue';
import MediaDetailDialog from './MediaDetailDialog.vue';

const media = useMediaStore();
const detailId = ref<number | null>(null);
const sentinel = ref<HTMLElement | null>(null);

let observer: IntersectionObserver | null = null;
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) void media.loadMore();
    },
    { rootMargin: '600px' },
  );
});
onBeforeUnmount(() => observer?.disconnect());

// sentinel は items>0 の分岐内にあるため、出現/消失に追随して監視を張り直す
watch(sentinel, (el, old) => {
  if (old) observer?.unobserve(old);
  if (el) observer?.observe(el);
});

function openDetail(item: MediaItem) {
  detailId.value = item.id;
}

/** 詳細ダイアログの前後ナビ用: 現在の一覧内で隣を開く */
function navigate(delta: number) {
  if (detailId.value === null) return;
  const idx = media.items.findIndex((m) => m.id === detailId.value);
  const next = media.items[idx + delta];
  if (next) detailId.value = next.id;
}

/** お気に入り変更を一覧へ反映 (全件再取得せずローカル更新) */
function onFavoriteChanged(id: number, favorite: boolean) {
  const item = media.items.find((m) => m.id === id);
  if (item) item.favorite = favorite ? 1 : 0;
}
</script>

<template>
  <div>
    <v-alert
      v-if="media.error"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-3"
      :text="`読み込みエラー: ${media.error}`"
    />
    <div v-if="media.loading && media.items.length === 0" class="grid">
      <v-skeleton-loader v-for="n in 12" :key="n" type="card" class="grid-item" />
    </div>
    <template v-else-if="media.items.length > 0">
      <div class="grid">
        <div v-for="item in media.items" :key="item.id" class="grid-item">
          <MediaCard :item="item" @open="openDetail" />
        </div>
      </div>
      <div ref="sentinel" class="sentinel">
        <v-progress-circular v-if="media.loadingMore" indeterminate color="primary" size="28" />
        <div v-else-if="!media.hasMore" class="text-caption text-medium-emphasis pa-4 text-center">
          全{{ media.total }}件を表示しました
        </div>
      </div>
    </template>
    <v-empty-state
      v-else
      icon="mdi-image-search-outline"
      title="メディアがまだありません"
      text="「手動収集」ボタンで5ch人気スレッドから画像・動画を収集できます"
    />
    <MediaDetailDialog
      v-if="detailId !== null"
      :media-id="detailId"
      @close="detailId = null"
      @navigate="navigate"
      @favorite-changed="onFavoriteChanged"
    />
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}
@media (max-width: 600px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
}
.sentinel {
  display: flex;
  justify-content: center;
  padding: 16px;
  min-height: 48px;
}
</style>
