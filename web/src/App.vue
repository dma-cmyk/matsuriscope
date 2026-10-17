<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import { ApiError } from './api';
import { useMediaStore, useMetaStore } from './stores';
import TutorialDialog from './components/TutorialDialog.vue';

const media = useMediaStore();
const meta = useMetaStore();
const route = useRoute();
const router = useRouter();
const display = useDisplay();
const isMobile = computed(() => display.smAndDown.value);
const drawer = ref(false);
const tutorial = ref<InstanceType<typeof TutorialDialog> | null>(null);

const searchText = ref(media.keyword);
watch(() => media.keyword, (value) => { searchText.value = value; });
function applySearch() {
  media.setFilter({ keyword: searchText.value ?? '' });
}

const tab = computed({
  get: () => (route.name === 'favorites' ? 'favorites' : 'home'),
  set: (v: string) => {
    if (v === 'favorites') router.push('/favorites');
    else router.push('/');
  },
});

const collectMessage = ref('');
const collectFailed = ref(false);
let statsTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

async function refreshStatus() {
  if (disposed) return;
  clearTimeout(statsTimer);
  try {
    await meta.refreshStats();
  } catch {
    // The shared statsError is displayed below; keep observing recovery and scheduled jobs.
  } finally {
    clearTimeout(statsTimer);
    if (!disposed) statsTimer = setTimeout(() => { void refreshStatus(); }, 3000);
  }
}

watch(() => meta.stats?.lastJob, (current, previous) => {
  if (current?.scope === 'hot' && current.status !== 'running' && previous
    && (current.id !== previous.id || previous.status === 'running')) void media.refresh();
});

onMounted(() => {
  void refreshStatus();
  void meta.refreshBoards();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(statsTimer);
});

async function onCollect() {
  if (!meta.stats || meta.statsError || meta.collecting || meta.stats.jobRunning) return;
  collectMessage.value = '';
  collectFailed.value = false;
  try {
    await meta.triggerCollect();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      collectMessage.value = '別の収集または板一覧の更新が始まりました。完了後にもう一度操作してください。';
    } else {
      collectFailed.value = true;
      collectMessage.value = `収集を開始できませんでした。${(error as Error).message}`;
    }
  } finally {
    await refreshStatus();
  }
}
</script>

<template>
  <v-app>
    <v-app-bar flat color="surface" class="app-bar">
      <v-app-bar-nav-icon v-if="isMobile" @click="drawer = !drawer" />
      <div class="logo d-flex align-center ga-2 ml-2">
        <span class="logo-icon">⛩</span>
        <span class="logo-text">Matsuri<span class="text-primary">Scope</span></span>
      </div>
      <v-text-field
        v-if="!isMobile"
        v-model="searchText"
        data-tour="search"
        aria-label="キーワード検索"
        class="mx-6 search-field"
        density="compact"
        variant="outlined"
        placeholder="キーワードでスレッド・画像・動画を検索..."
        prepend-inner-icon="mdi-magnify"
        hide-details
        clearable
        @keyup.enter="applySearch"
        @click:clear="media.setFilter({ keyword: '' })"
      />
      <v-spacer />
      <v-btn
        icon="mdi-help-circle-outline"
        variant="text"
        size="small"
        aria-label="使い方を見る"
        title="使い方を見る"
        @click="tutorial?.open()"
      />
      <v-btn
        color="primary"
        variant="tonal"
        size="small"
        data-tour="collect"
        :loading="meta.collecting || (meta.stats?.jobRunning ?? false)"
        :disabled="!meta.stats || !!meta.statsError"
        prepend-icon="mdi-refresh"
        @click="onCollect"
      >
        {{ meta.stats?.jobRunning ? '収集中…' : '手動収集' }}
      </v-btn>
    </v-app-bar>

    <v-navigation-drawer :model-value="drawer || !isMobile" :permanent="!isMobile" color="surface" width="220" @update:model-value="drawer = $event">
      <v-list nav density="compact">
        <v-list-item
          prepend-icon="mdi-home"
          title="ホーム"
          :active="tab === 'home'"
          active-color="primary"
          @click="tab = 'home'"
        />
        <v-list-item
          prepend-icon="mdi-star"
          data-tour="favorites"
          title="お気に入り"
          :active="tab === 'favorites'"
          active-color="primary"
          @click="tab = 'favorites'"
        />
        <v-list-item
          prepend-icon="mdi-help-circle-outline"
          title="使い方を見る"
          @click="drawer = false; tutorial?.open()"
        />
      </v-list>
      <v-divider class="my-2" />
      <div class="px-4 py-2 text-caption text-medium-emphasis">
        <div>収集間隔: {{ meta.stats?.collectIntervalMinutes ?? 30 }}分ごと</div>
        <div>対象板: {{ meta.stats?.boards ?? '-' }}板</div>
        <div v-if="meta.stats?.lastCollectAt">
          最終収集: {{ new Date(Number(meta.stats.lastCollectAt) * 1000).toLocaleString('ja-JP') }}
        </div>
      </div>
    </v-navigation-drawer>

    <v-main>
      <v-alert v-if="meta.statsError" type="warning" variant="tonal" density="compact" class="ma-4" role="alert">
        {{ meta.statsError }} 最新の状態を確認できるまで収集操作を停止しています。
        <v-btn variant="text" size="small" @click="refreshStatus">状況を再読み込み</v-btn>
      </v-alert>
      <router-view />
      <TutorialDialog ref="tutorial" @started="drawer = false" />
    </v-main>
    <v-snackbar :model-value="!!collectMessage" :color="collectFailed ? 'error' : 'info'" @update:model-value="collectMessage = $event ? collectMessage : ''">{{ collectMessage }}</v-snackbar>

    <v-bottom-navigation v-if="isMobile" color="primary" grow>
      <v-btn value="home" :active="tab === 'home'" @click="tab = 'home'">
        <v-icon>mdi-home</v-icon>
        <span>ホーム</span>
      </v-btn>
      <v-btn value="favorites" data-tour="favorites" :active="tab === 'favorites'" @click="tab = 'favorites'">
        <v-icon>mdi-star</v-icon>
        <span>お気に入り</span>
      </v-btn>
    </v-bottom-navigation>
  </v-app>
</template>

<style scoped>
.app-bar {
  border-bottom: 1px solid rgba(34, 211, 238, 0.15);
}
.logo-icon {
  font-size: 1.4rem;
}
.logo-text {
  font-weight: 700;
  font-size: 1.15rem;
  letter-spacing: 0.02em;
}
.search-field {
  max-width: 480px;
}
</style>
