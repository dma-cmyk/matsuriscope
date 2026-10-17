<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import { api, ApiError, type CollectionJob, type CollectStatus, type JobEvent } from '../api';
import { useMediaStore, useMetaStore } from '../stores';

const media = useMediaStore();
const meta = useMetaStore();
const router = useRouter();
const display = useDisplay();
const expandChoice = ref<boolean | null>(null);
const expanded = computed(() => expandChoice.value ?? !display.smAndDown.value);
const selectedId = ref<number | null>(null);
const job = ref<CollectionJob | null>(null);
const events = ref<JobEvent[]>([]);
const pendingJobId = ref<number | null>(null);
const refreshingBoards = ref(false);
const starting = ref(false);
const stopping = ref(false);
const syncing = ref(false);
const actionError = ref('');
const actionNotice = ref('');
const connectionError = ref('');
let disposed = false;
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const boardOptions = computed(() => meta.boards.filter((board) => board.enabled === 1).map((board) => ({
  ...board,
  key: `${board.server}/${board.board_key}`,
  label: `${board.name} — ${board.server}/${board.board_key} — ${board.category}`,
})));
const selected = computed(() => boardOptions.value.find((board) => board.id === selectedId.value));
const busy = computed(() => refreshingBoards.value || starting.value || pendingJobId.value !== null || meta.collecting || !!meta.stats?.jobRunning || job.value?.status === 'running');
const statusUnavailable = computed(() => !meta.stats || !!meta.statsError || !!connectionError.value);
const activeJob = computed(() => meta.stats?.jobRunning && meta.stats.lastJob?.status === 'running' ? meta.stats.lastJob : null);
const activeLabel = computed(() => {
  const current = activeJob.value;
  if (!current) return '板一覧の更新';
  if (current.scope === 'board') return `${current.board_name ?? current.board_key}の全スレッド収集`;
  return current.trigger_type === 'schedule' ? '人気スレッドの自動収集'
    : current.trigger_type === 'startup' ? '起動時の収集' : '人気スレッドの手動収集';
});
const progress = computed(() => {
  if (!job.value?.threads_total) return job.value?.status === 'success' ? 100 : 0;
  return Math.min(100, (job.value.threads_attempted / job.value.threads_total) * 100);
});
const statuses: Record<CollectStatus, { label: string; color: string }> = {
  running: { label: '収集中', color: 'primary' },
  success: { label: '全スレッドの処理完了', color: 'success' },
  partial: { label: '一部のスレッドで失敗', color: 'warning' },
  error: { label: '収集に失敗', color: 'error' },
  cancelled: { label: '停止済み', color: 'warning' },
  interrupted: { label: 'サーバー停止により中断', color: 'warning' },
};
const status = computed(() => job.value ? statuses[job.value.status] : null);

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (!disposed && !connectionError.value && busy.value && !starting.value) {
    timer = setTimeout(() => { void sync(); }, 3000);
  }
}

async function sync() {
  const token = ++sequence;
  syncing.value = true;
  connectionError.value = '';
  try {
    const jobRequest = pendingJobId.value !== null
      ? api.job(pendingJobId.value).then((result) => ({ jobs: [result.job], events: result.events }))
      : api.jobs();
    const [result] = await Promise.all([jobRequest, meta.refreshStats()]);
    if (disposed || token !== sequence) return;
    const latest = result.jobs.find((item) => item.scope === 'board');
    const previous = job.value;
    if (latest) {
      job.value = latest;
      pendingJobId.value = null;
      events.value = result.events.filter((event) => event.job_id === latest.id);
      if (selectedId.value === null) selectedId.value = latest.board_id;
      const changed = !previous || previous.id !== latest.id || previous.media_found !== latest.media_found || previous.status !== latest.status;
      if (changed && media.board === latest.board_key) await media.refresh();
    }
  } catch (error) {
    if (!disposed && token === sequence) connectionError.value = `最新の収集状況を取得できませんでした。${(error as Error).message}`;
  } finally {
    if (!disposed && token === sequence) {
      syncing.value = false;
      schedule();
    }
  }
}

async function refreshBoards() {
  if (busy.value || statusUnavailable.value) return;
  refreshingBoards.value = true;
  actionError.value = '';
  actionNotice.value = '';
  try {
    await meta.refreshStats();
    if (disposed) return;
    if (meta.stats?.jobRunning) {
      await sync();
      return;
    }
    const result = await api.refreshBoards();
    if (!disposed) meta.boards = result.items;
  } catch (error) {
    if (!disposed) {
      if (error instanceof ApiError && error.status === 409) {
        actionNotice.value = '別の収集または板一覧の更新と操作が重なりました。板一覧はまだ更新していません。完了後にもう一度「板一覧を更新」を押してください。';
        await sync();
      } else actionError.value = `板一覧を更新できませんでした。${(error as Error).message}`;
    }
  } finally {
    if (!disposed) {
      refreshingBoards.value = false;
      schedule();
    }
  }
}

async function showBoard(key = selected.value?.key) {
  if (!key) return;
  await router.push('/');
  media.setFilter({ board: key, typeFilter: 'all', keyword: '', period: '' });
}

async function start() {
  const board = selected.value;
  if (!board || busy.value || statusUnavailable.value) return;
  starting.value = true;
  expandChoice.value = true;
  actionError.value = '';
  actionNotice.value = '';
  clearTimeout(timer);
  try {
    // Close the idle-poll gap before sending a write; the server lock remains authoritative.
    await meta.refreshStats();
    if (disposed) return;
    if (meta.stats?.jobRunning) {
      await sync();
      return;
    }
    const accepted = await api.collectBoard(board.id);
    if (disposed) return;
    pendingJobId.value = accepted.jobId;
    await showBoard(board.key);
    await sync();
  } catch (error) {
    if (!disposed) {
      if (pendingJobId.value !== null) connectionError.value = `収集 #${pendingJobId.value} は受理されましたが、画面を更新できませんでした。${(error as Error).message}`;
      else if (error instanceof ApiError && error.status === 409) {
        actionNotice.value = '別の収集または板一覧の更新と操作が重なりました。この板の収集はまだ始まっていません。完了後にもう一度「全スレッドを収集」を押してください。';
        await sync();
      } else actionError.value = `収集を開始できませんでした。${(error as Error).message}`;
    }
  } finally {
    if (!disposed) {
      starting.value = false;
      schedule();
    }
  }
}

async function stop() {
  if (!job.value || job.value.status !== 'running' || stopping.value) return;
  const id = job.value.id;
  stopping.value = true;
  actionError.value = '';
  try {
    await api.cancelJob(id);
    await sync();
  } catch (error) {
    if (!disposed) actionError.value = `停止要求を送れませんでした。${(error as Error).message}`;
  } finally {
    if (!disposed) stopping.value = false;
  }
}

watch([() => meta.stats?.jobRunning, () => meta.stats?.lastJob?.id], () => {
  if (!syncing.value && !starting.value && !refreshingBoards.value) void sync();
});
watch(() => media.board, (key) => {
  if (!selectedId.value) selectedId.value = boardOptions.value.find((board) => board.key === key)?.id ?? null;
});
onMounted(() => { void sync(); });
onBeforeUnmount(() => {
  disposed = true;
  ++sequence;
  clearTimeout(timer);
});
</script>

<template>
  <v-card color="surface" flat class="board-collector pa-4" data-board-collector>
    <div class="d-flex flex-wrap align-center ga-2 mb-2">
      <v-icon icon="mdi-forum-outline" color="primary" size="22" />
      <h2 class="text-subtitle-1 font-weight-bold">板を選んで全スレッドを収集</h2>
      <v-spacer />
      <v-btn v-if="expanded" variant="text" size="small" prepend-icon="mdi-refresh" :loading="refreshingBoards" :disabled="busy || statusUnavailable" @click="refreshBoards">板一覧を更新</v-btn>
      <v-btn :icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'" variant="text" size="small" :aria-label="expanded ? '板収集の設定を閉じる' : '板収集の設定を開く'" :aria-expanded="expanded" @click="expandChoice = !expanded" />
    </div>
    <p v-if="!expanded" class="text-caption text-medium-emphasis mb-0" role="status">
      <template v-if="connectionError || actionError">取得エラーがあります。設定を開いて確認してください。</template>
      <template v-else-if="meta.stats?.jobRunning">{{ activeLabel }}が実行中です。完了後に板の収集を開始できます。</template>
      <template v-else-if="job && status">{{ job.board_name }} — {{ status.label }}（{{ job.threads_attempted }} / {{ job.threads_total }}）</template>
      <template v-else>板を指定し、全スレッドの画像・動画を取得できます。</template>
    </p>
    <template v-if="expanded">
    <p class="text-caption text-medium-emphasis mb-4">選んだ板の現在のスレッド一覧を取得し、全件を順番に巡回します。人気順の上限は使いません。過去ログは対象外です。</p>
    <div class="board-controls">
      <v-autocomplete
        v-model="selectedId"
        :items="boardOptions"
        item-title="label"
        item-value="id"
        label="収集する5chの板"
        aria-label="収集する5chの板"
        placeholder="板名・カテゴリ・サーバーで検索"
        variant="outlined"
        density="compact"
        :no-data-text="meta.boards.length ? '該当する板がありません' : '「板一覧を更新」で公式の板一覧を取得してください'"
        :loading="refreshingBoards"
        hide-details
        clearable
        class="board-picker"
      />
      <v-btn color="primary" variant="flat" prepend-icon="mdi-play" :loading="starting" :disabled="!selected || busy || statusUnavailable" @click="start">全スレッドを収集</v-btn>
      <v-btn variant="outlined" :disabled="!selected" @click="showBoard()">収集済み一覧</v-btn>
    </div>
    <p class="text-caption text-medium-emphasis mt-3 mb-0">リクエスト間隔を守って1件ずつ取得します。スレッド数の多い板は時間がかかります。収集中の板の一覧は順次更新されます。</p>
    <v-alert v-if="actionError" type="error" variant="tonal" density="compact" class="mt-3" role="alert">{{ actionError }}</v-alert>
    <v-alert v-if="actionNotice" type="info" variant="tonal" density="compact" class="mt-3" role="status">{{ actionNotice }}</v-alert>
    <v-alert v-if="connectionError" type="warning" variant="tonal" density="compact" class="mt-3" role="alert">
      {{ connectionError }}<v-btn variant="text" size="small" :loading="syncing" @click="sync">進捗を再読み込み</v-btn>
    </v-alert>
    <v-alert v-if="meta.stats?.jobRunning && job?.status !== 'running'" type="info" variant="tonal" density="compact" class="mt-3" role="status" aria-label="実行中の収集">
      <strong>{{ activeLabel }}が実行中です。</strong>
      <span v-if="activeJob?.threads_total"> 処理済み {{ activeJob.threads_attempted }} / {{ activeJob.threads_total }} スレッド</span>
      <p class="text-caption mt-1 mb-0">同時取得を避けるため、板の収集はまだ始めていません。完了するとボタンが自動で有効になります。選択した板はそのまま保持されます。</p>
    </v-alert>
    <section v-if="job && status" class="board-job mt-4 pa-3" aria-label="板収集の進捗">
      <div class="d-flex align-center flex-wrap ga-2 mb-3">
        <strong class="text-body-2">{{ job.board_name ?? job.board_key }}</strong>
        <v-chip :color="status.color" size="small" variant="tonal">{{ job.cancel_requested && job.status === 'running' ? '停止処理中' : status.label }}</v-chip>
        <v-spacer />
        <v-btn v-if="job.status === 'running'" color="warning" variant="text" size="small" :disabled="!!job.cancel_requested" :loading="stopping" @click="stop">収集を停止</v-btn>
        <v-btn v-if="job.board_key" variant="text" size="small" @click="showBoard(job!.board_key!)">この板の一覧を見る</v-btn>
      </div>
      <v-progress-linear :model-value="progress" :indeterminate="job.status === 'running' && !job.threads_total" :color="status.color" rounded height="6" class="mb-3" />
      <div class="job-counts text-caption" aria-live="polite" aria-atomic="true">
        <span>処理済み <strong>{{ job.threads_attempted.toLocaleString() }} / {{ job.threads_total.toLocaleString() }}</strong> スレッド</span>
        <span>取得成功 {{ job.threads_fetched.toLocaleString() }}</span>
        <span class="text-primary">新規メディア {{ job.media_new.toLocaleString() }}</span>
        <span :class="{'text-warning': job.errors > 0}">エラー {{ job.errors.toLocaleString() }}</span>
      </div>
      <div v-if="job.current_thread && job.status === 'running'" class="text-caption text-medium-emphasis text-truncate mt-2">取得中: {{ job.current_thread }}</div>
      <p v-if="job.cancel_requested && job.status === 'running'" class="text-caption text-warning mt-2">現在の取得が終わると停止します。取得済みメディアは残ります。</p>
      <p v-if="job.message && job.status !== 'running'" class="text-caption text-medium-emphasis mt-2 mb-0">{{ job.message }}</p>
      <details v-if="events.length" class="job-events mt-3">
        <summary class="text-caption text-medium-emphasis">取得ログ・エラー（最新{{ events.length }}件）</summary>
        <ul class="mt-2">
          <li v-for="event in events" :key="event.id" class="text-caption mb-2" :class="{'text-warning': event.level === 'warn', 'text-error': event.level === 'error'}">{{ new Date(event.ts * 1000).toLocaleTimeString('ja-JP') }} {{ event.message }}</li>
        </ul>
      </details>
    </section>
    </template>
  </v-card>
</template>

<style scoped>
.board-collector { border: 1px solid rgba(34, 211, 238, .2); border-radius: 12px; }
.board-controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.board-picker { flex: 1 1 360px; min-width: 0; }
.board-job { border: 1px solid rgba(148, 163, 184, .15); border-radius: 8px; background: rgba(34, 211, 238, .025); }
.job-counts { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.job-events summary { cursor: pointer; }
.job-events ul { list-style: none; padding-left: 0; max-height: 180px; overflow-y: auto; overflow-wrap: anywhere; }
@media (max-width: 600px) {
  .board-controls { gap: 10px; }
  .board-picker { flex-basis: 100%; }
  .board-controls > .v-btn { flex: 1; }
}
</style>
