<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { xPostEmbed, xPostResizeHeight } from '../xEmbed';

const props = defineProps<{ url: string }>();
const embed = computed(() => xPostEmbed(props.url));
const frame = ref<HTMLIFrameElement | null>(null);
const height = ref(800);
const revision = ref(0);

function reload() {
  height.value = 800;
  revision.value += 1;
}
watch(() => props.url, reload);

function onMessage(event: MessageEvent) {
  if (!embed.value) return;
  const nextHeight = xPostResizeHeight(event, frame.value?.contentWindow, embed.value.embedId);
  if (nextHeight !== null) height.value = nextHeight;
}
onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => window.removeEventListener('message', onMessage));
</script>

<template>
  <section class="x-preview" aria-label="X投稿の公式プレビュー">
    <template v-if="embed">
      <div class="x-actions d-flex flex-wrap align-center ga-2 pa-3">
        <span class="text-caption text-medium-emphasis">X公式埋め込み（画像・動画）</span>
        <v-btn :href="embed.originalUrl" target="_blank" rel="noopener noreferrer" size="small" variant="tonal" prepend-icon="mdi-open-in-new">
          Xで元投稿を開く
        </v-btn>
        <v-btn size="small" variant="text" prepend-icon="mdi-reload" @click="reload">投稿を再読み込み</v-btn>
      </div>
      <p class="text-caption text-medium-emphasis px-3 pb-3">
        表示・再生はX側の提供状況によります。動画は再生ボタンを押してください。
        削除・非公開・年齢制限・埋め込み非対応やブラウザーの追跡防止などで表示できない場合、元投稿を開いてご確認ください。
        引用動画などは「Xで動画を見る」と表示され、アプリ内で再生できないことがあります。
      </p>
      <!-- No load/success indicator: a loaded cross-origin document does not prove the post or media is available. -->
      <iframe
        :key="`${embed.embedId}-${revision}`"
        ref="frame"
        :src="embed.src"
        :style="{ height: `${height}px` }"
        class="x-frame"
        title="X投稿の画像・動画（X公式埋め込み）"
        allow="autoplay 'none'; fullscreen; picture-in-picture; encrypted-media"
        allowfullscreen
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
        referrerpolicy="no-referrer"
      />
    </template>
    <p v-else class="pa-4 text-body-2" role="alert">X投稿URLの形式を確認できないため、埋め込みを表示できません。</p>
  </section>
</template>

<style scoped>
.x-preview {
  width: 100%;
  min-width: 0;
  align-self: flex-start;
}
.x-frame {
  display: block;
  width: 100%;
  max-width: 550px;
  margin-inline: auto;
  border: 0;
  /* Validated resize messages expand the complete post; retain iframe scrolling
     if X changes its message protocol rather than hiding overflowing media. */
}
</style>
