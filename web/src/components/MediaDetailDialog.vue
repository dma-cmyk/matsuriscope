<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { api, type MediaDetail } from '../api';

const props = defineProps<{ mediaId: number }>();
const emit = defineEmits<{
  close: [];
  navigate: [delta: number];
  'favorite-changed': [id: number, favorite: boolean];
}>();

const display = useDisplay();
const fullscreen = computed(() => display.smAndDown.value);

const detail = ref<MediaDetail | null>(null);
const loadError = ref<string | null>(null);
const mediaError = ref(false);
const copied = ref(false);
let loadSeq = 0;

async function load(id: number) {
  const seq = ++loadSeq; // 前後ナビ連打で遅れた古い応答を破棄する
  detail.value = null;
  loadError.value = null;
  mediaError.value = false;
  try {
    const res = await api.mediaDetail(id);
    if (seq !== loadSeq) return;
    detail.value = res;
  } catch (e) {
    if (seq !== loadSeq) return;
    loadError.value = (e as Error).message;
  }
}
onMounted(() => void load(props.mediaId));

// キーボードナビ (← → ESC)
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
  if (e.key === 'ArrowLeft') emit('navigate', -1);
  if (e.key === 'ArrowRight') emit('navigate', 1);
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// id が変わったら再読込 (前後ナビ)
watch(() => props.mediaId, (id) => void load(id));

const media = computed(() => detail.value?.media ?? null);
const firstOcc = computed(() => detail.value?.occurrences[0] ?? null);

const youtubeEmbed = computed(() => {
  if (media.value?.type !== 'youtube') return null;
  // サーバー保存の canonical URL (https://youtu.be/{id}) からIDを取り出すのが確実
  const m = /youtu\.be\/([\w-]{6,20})/.exec(media.value.url);
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null;
});

async function toggleFavorite() {
  if (!media.value) return;
  const next = media.value.favorite !== 1;
  await api.setFavorite(media.value.id, next);
  media.value.favorite = next ? 1 : 0;
  emit('favorite-changed', media.value.id, next);
  const { useMetaStore } = await import('../stores');
  void useMetaStore().refreshStats();
}

async function copyUrl() {
  if (!media.value) return;
  try {
    await navigator.clipboard.writeText(media.value.url);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* クリップボード不可時は無視 */
  }
}
</script>

<template>
  <v-dialog
    :model-value="true"
    :fullscreen="fullscreen"
    max-width="1000"
    scrollable
    @update:model-value="(v) => !v && emit('close')"
  >
    <v-card color="surface" class="detail-card">
      <v-card-title class="d-flex align-center py-2">
        <v-btn icon="mdi-chevron-left" variant="text" size="small" @click="emit('navigate', -1)" />
        <v-btn icon="mdi-chevron-right" variant="text" size="small" @click="emit('navigate', 1)" />
        <span class="text-body-2 text-medium-emphasis ml-2 text-truncate">
          {{ firstOcc?.thread_title ?? '読み込み中…' }}
        </span>
        <v-spacer />
        <v-btn
          icon
          variant="text"
          :color="media?.favorite === 1 ? 'warning' : 'medium-emphasis'"
          @click="toggleFavorite"
        >
          <v-icon :icon="media?.favorite === 1 ? 'mdi-star' : 'mdi-star-outline'" />
        </v-btn>
        <v-btn icon="mdi-close" variant="text" @click="emit('close')" />
      </v-card-title>
      <v-divider />
      <v-card-text class="pa-0">
        <v-alert v-if="loadError" type="error" variant="tonal" class="ma-4" :text="loadError" />
        <div v-else-if="detail && media" class="detail-body">
          <div class="preview-area">
            <v-img
              v-if="(media.type === 'image' || media.type === 'gif') && !mediaError"
              :src="media.url"
              max-height="65vh"
              contain
              @error="mediaError = true"
            />
            <video
              v-else-if="media.type === 'video' && !mediaError"
              :src="media.url"
              controls
              playsinline
              class="video-player"
              @error="mediaError = true"
            />
            <iframe
              v-else-if="media.type === 'youtube' && youtubeEmbed"
              :src="youtubeEmbed"
              class="youtube-embed"
              frameborder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen
              sandbox="allow-scripts allow-same-origin allow-presentation"
              referrerpolicy="strict-origin-when-cross-origin"
            />
            <div v-else class="preview-fallback">
              <v-icon icon="mdi-link-variant" size="48" color="medium-emphasis" />
              <div class="text-body-2 mt-2">
                {{ mediaError ? 'メディアを読み込めませんでした (削除済み・転載禁止の可能性)' : 'このメディアは埋め込みプレビューに対応していません' }}
              </div>
              <v-btn :href="media.url" target="_blank" rel="noopener noreferrer" color="primary" variant="tonal" class="mt-3">
                元URLを開く
              </v-btn>
            </div>
          </div>
          <div class="info-area pa-4">
            <div class="text-subtitle-1 font-weight-bold mb-2">{{ firstOcc?.thread_title }}</div>
            <div class="d-flex flex-wrap ga-2 mb-3">
              <v-chip size="small" color="primary" variant="tonal">{{ firstOcc?.board_name }}</v-chip>
              <v-chip size="small" variant="outlined">🔥 勢い {{ Math.round(firstOcc?.ikioi ?? 0).toLocaleString() }}</v-chip>
              <v-chip size="small" variant="outlined">レス {{ firstOcc?.res_count.toLocaleString() }}</v-chip>
              <v-chip v-if="firstOcc?.res_no" size="small" variant="outlined">&gt;&gt;{{ firstOcc.res_no }}</v-chip>
            </div>
            <div class="d-flex flex-wrap ga-2 mb-4">
              <v-btn :href="firstOcc?.thread_url" target="_blank" rel="noopener noreferrer" size="small" color="primary" variant="flat" prepend-icon="mdi-open-in-new">
                元スレッドを開く
              </v-btn>
              <v-btn :href="media.url" target="_blank" rel="noopener noreferrer" size="small" variant="outlined" prepend-icon="mdi-link">
                メディアURL
              </v-btn>
              <v-btn size="small" variant="outlined" :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'" @click="copyUrl">
                {{ copied ? 'コピー済み' : 'URLコピー' }}
              </v-btn>
            </div>
            <template v-if="detail.occurrences.length > 1">
              <div class="text-caption text-medium-emphasis mb-1">他の出典 ({{ detail.occurrences.length - 1 }}件)</div>
              <v-list density="compact" class="occ-list">
                <v-list-item
                  v-for="(occ, i) in detail.occurrences.slice(1)"
                  :key="i"
                  :href="occ.thread_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="occ.thread_title"
                  :subtitle="`${occ.board_name} / レス${occ.res_count}`"
                  append-icon="mdi-open-in-new"
                />
              </v-list>
            </template>
          </div>
        </div>
        <div v-else class="d-flex justify-center pa-10">
          <v-progress-circular indeterminate color="primary" />
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.detail-body {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
}
@media (max-width: 800px) {
  .detail-body {
    grid-template-columns: 1fr;
  }
}
.preview-area {
  background: #05070d;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}
.video-player {
  width: 100%;
  max-height: 65vh;
}
.youtube-embed {
  width: 100%;
  aspect-ratio: 16 / 9;
}
.preview-fallback {
  text-align: center;
  padding: 40px 20px;
  color: rgba(229, 231, 235, 0.7);
}
.occ-list {
  background: transparent;
  max-height: 200px;
  overflow-y: auto;
}
</style>
