<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import { useMediaStore, useMetaStore } from './stores';

const media = useMediaStore();
const meta = useMetaStore();
const route = useRoute();
const router = useRouter();
const display = useDisplay();
const isMobile = computed(() => display.smAndDown.value);
const drawer = ref(false);

const searchText = ref('');
function applySearch() {
  media.setFilter({ keyword: searchText.value });
}

const tab = computed({
  get: () => (route.name === 'favorites' ? 'favorites' : 'home'),
  set: (v: string) => {
    if (v === 'favorites') router.push('/favorites');
    else router.push('/');
  },
});

onMounted(() => {
  void meta.refreshStats();
  void meta.refreshBoards();
});

let statsTimer: NodeJS.Timeout | undefined;
async function onCollect() {
  try {
    await meta.triggerCollect();
  } catch {
    return; // 409 (収集中) 等は無視
  }
  // 収集中は5秒ごとに統計をポーリング (失敗6回 or 完了で停止)
  clearInterval(statsTimer);
  let failures = 0;
  statsTimer = setInterval(() => {
    void (async () => {
      try {
        await meta.refreshStats();
        failures = 0;
        if (!meta.stats?.jobRunning) {
          clearInterval(statsTimer);
          void media.refresh(); // 新着メディアを反映
        }
      } catch {
        if (++failures >= 6) clearInterval(statsTimer);
      }
    })();
  }, 5000);
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
        class="mx-6 search-field"
        density="compact"
        variant="outlined"
        placeholder="キーワードでスレッド・画像・動画を検索..."
        prepend-inner-icon="mdi-magnify"
        hide-details
        clearable
        @keyup.enter="applySearch"
        @click:clear="applySearch"
      />
      <v-spacer />
      <v-btn
        color="primary"
        variant="tonal"
        size="small"
        :loading="meta.collecting || (meta.stats?.jobRunning ?? false)"
        prepend-icon="mdi-refresh"
        @click="onCollect"
      >
        {{ meta.stats?.jobRunning ? '収集中…' : '手動収集' }}
      </v-btn>
    </v-app-bar>

    <v-navigation-drawer v-model="drawer" :permanent="!isMobile" color="surface" width="220">
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
          title="お気に入り"
          :active="tab === 'favorites'"
          active-color="primary"
          @click="tab = 'favorites'"
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
      <router-view />
    </v-main>

    <v-bottom-navigation v-if="isMobile" color="primary" grow>
      <v-btn value="home" :active="tab === 'home'" @click="tab = 'home'">
        <v-icon>mdi-home</v-icon>
        <span>ホーム</span>
      </v-btn>
      <v-btn value="favorites" :active="tab === 'favorites'" @click="tab = 'favorites'">
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
