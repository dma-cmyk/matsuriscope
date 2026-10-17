<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMediaStore, useMetaStore } from '../stores';
import { tutorialSteps, useTutorialStore, type TutorialStepId } from '../tutorial';

const emit = defineEmits<{ started: [] }>();
const tour = useTutorialStore();
const media = useMediaStore();
const meta = useMetaStore();
const router = useRouter();
const route = useRoute();
const panel = ref<HTMLElement | null>(null);
const preparing = ref(false);
const example = ref('');
const rect = ref<{ top: number; left: number; width: number; height: number } | null>(null);
const panelStyle = ref<Record<string, string>>({});
const focusedInput = ref(false);
const compact = computed(() => focusedInput.value && window.innerWidth < 600);
const verified = computed(() => tour.verified.includes(tour.stepId));
const needsMedia = computed(() => ['detail', 'source', 'favorite'].includes(tour.stepId) && !media.items.length && !tour.detailOpen);
const savedCount = computed(() => tour.verified.length);
let generation = 0;
let frame = 0;
let observer: ResizeObserver | null = null;
let observedTarget: HTMLElement | null = null;
let collectTimer: ReturnType<typeof setInterval> | undefined;
let snapshot: { path: string; scroll: number; filters: Pick<typeof media, 'typeFilter' | 'keyword' | 'sort' | 'board' | 'period'> } | null = null;

const content = computed(() => {
  switch (tour.stepId) {
    case 'collect': return {
      text: '右上の「手動収集」で、公開スレッドから画像・動画のURLを集めます。自動収集の間隔と直近の結果は統計欄で確認できます。',
      task: meta.stats?.mediaTotal ? 'すでに実データがあります。収集ボタンを押さずに次へ進めます。' : '一覧が空なら「手動収集」を押してください。収集は数分かかることがあります。待たずに次の機能の場所を確認することもできます。',
      tip: 'ツアーを開くだけで収集は実行しません。メディア本体のダウンロードや再配信も行いません。',
    };
    case 'type': return {
      text: '一覧上部のチップは、表示するメディアの種類を切り替えるボタンです。',
      task: '強調されている「画像」「動画」「GIF」のどれかを押してください。',
      tip: '「すべて」に戻せば種類の絞り込みを解除できます。件数が0でも、選択した種類の表示に切り替わります。',
    };
    case 'search': return {
      text: '検索欄にキーワードを入力してEnterを押すと、収集したメディアのスレッド名などを検索します。',
      task: example.value ? `例えば「${example.value}」を入力し、Enterを押してみましょう。好きな言葉でも構いません。` : '気になるキーワードを入力し、Enterを押してください。',
      tip: '文字を入力しただけでは検索しません。検索欄の×で解除できます。次の手順では検索を自動的に解除します。',
    };
    case 'sort': return {
      text: '並び順・板・期間を組み合わせると、見たい範囲をさらに絞り込めます。スマートフォンでは調整ボタンから開く欄です。',
      task: '「並び順」を開いて「新着順」を選んでください。',
      tip: '新着順はアプリが発見した日時順です。勢い順はスレッドの投稿ペース、話題スコア順は複数スレッドへの登場も加味します。',
    };
    case 'detail': return {
      text: 'メディアカードから大きなプレビューと投稿元を確認できます。',
      task: tour.detailOpen ? '詳細が開きました。画像・動画のプレビューと、投稿元の情報がセットになっています。'
        : tour.detailVisible ? '詳細を読み込んでいます。エラーの場合は「詳細を再読み込み」で再試行できます。'
        : '強調されているカードを押して、詳細を開いてください。',
      tip: '削除済みの画像や対応していない外部サービスはプレビューできません。データを捏造せず、元URLへのリンクを表示します。',
    };
    case 'source': return {
      text: '「元スレッドを開く」は投稿元、「メディアURL」は画像・動画そのものへのリンクです。URLコピーから共有用のURLを取得できます。',
      task: '板名・レス番号を確認しましょう。「勢い」は投稿ペースで、画像の評価数ではありません。外部リンクは開かなくても進めます。',
      tip: '出典が複数ある場合は「他の出典」も表示されます。リンク先は別タブで開き、削除済みの場合は閲覧できないことがあります。',
    };
    case 'favorite': return {
      text: '詳細画面の星ボタンで、このメディアをお気に入りに保存できます。',
      task: tour.selectedFavorite ? 'このメディアは保存済みです。解除せず、そのまま次へ進めます。' : '強調されている☆を押してください。保存に成功すると星が色付きになります。',
      tip: '練習で付けたお気に入りも実際に保存されます。後で同じ星を押すと解除できます。',
    };
    case 'favorites': return {
      text: 'サイドバー、またはスマートフォンの画面下から、保存したメディアだけを見返せます。',
      task: '強調されている「お気に入り」を押して、一覧を開いてください。',
      tip: 'ツアー終了時には、開始前の検索条件と並び順に戻します。保存したお気に入りは残ります。使い方は右上のヘルプから再開・再実行できます。',
    };
  }
});

const feedback = computed(() => {
  if (preparing.value || media.loading) return '画面を準備しています…';
  if (media.error) return '読み込みに失敗しています。再読み込みするか、この手順を後回しにできます。';
  if (verified.value) {
    if (tour.stepId === 'search') return media.keyword.trim()
      ? `検索できました。結果は${media.total}件です。${media.total === 0 ? '別の言葉でも試せます。' : ''}`
      : '検索操作は前回確認済みです。もう一度試すか、次へ進めます。';
    if (tour.stepId === 'favorite') return 'お気に入りへの保存を確認しました。';
    return '操作を確認しました。次へ進めます。';
  }
  if (needsMedia.value) return '表示できるメディアがまだありません。収集後に再開するか、この手順を後回しにしてください。';
  return tour.step.action ? '画面を操作すると、ここに結果が表示されます。' : '場所と説明を確認したら、次へ進めます。';
});

function open() { tour.open(); }
defineExpose({ open });

async function start(resume: boolean) {
  if (preparing.value) return;
  snapshot = {
    path: route.path, scroll: window.scrollY,
    filters: { typeFilter: media.typeFilter, keyword: media.keyword, sort: media.sort, board: media.board, period: media.period },
  };
  emit('started');
  tour.start(resume);
}

async function prepareStep() {
  if (!tour.running) return;
  const token = ++generation;
  preparing.value = true;
  focusedInput.value = false;
  rect.value = null;
  const id = tour.stepId;
  tour.requestedDetailId = null;
  try {
    if (!['source', 'favorite'].includes(id)) {
      await router.push('/');
      if (token !== generation || !tour.running) return;
      await nextTick();
      Object.assign(media, { typeFilter: 'all', keyword: '', board: '', period: '' });
      if (['collect', 'type', 'search', 'sort'].includes(id)) media.sort = 'ikioi';
      await media.refresh();
    }
    if (token !== generation || !tour.running) return;
    if (!example.value && media.items[0]) {
      example.value = media.items[0].thread_title.replace(/[【】「」\[\]\s★]/g, '').slice(0, 4);
    }
    if (['source', 'favorite'].includes(id)) {
      const selected = tour.selectedId ?? media.items[0]?.id;
      if (selected) tour.requestedDetailId = selected;
      if (id === 'favorite' && tour.selectedFavorite) tour.confirm('favorite');
    }
    await nextTick();
    if (token === generation && tour.running) {
      scrollToTarget();
      panel.value?.focus({ preventScroll: true });
    }
  } finally {
    if (token === generation) preparing.value = false;
  }
}

async function restore() {
  ++generation;
  rect.value = null;
  preparing.value = true;
  const previous = snapshot;
  snapshot = null;
  try {
    if (previous) {
      await router.push(previous.path);
      await nextTick();
      Object.assign(media, previous.filters);
      await media.refresh();
      await nextTick();
      window.scrollTo({ top: previous.scroll, behavior: 'instant' });
    }
  } finally {
    preparing.value = false;
  }
}

function target(): HTMLElement | null {
  let selector: string;
  const targets: Record<TutorialStepId, string> = {
    collect: '[data-tour="collect"]', type: '[data-tour="types"]', search: '[data-tour="search"]',
    sort: '[data-tour="sort"]', detail: tour.detailVisible
      ? tour.detailOpen ? '[data-tour="detail-preview"]' : '[data-tour="detail-status"]'
      : '[data-tour="media-card"]',
    source: '[data-tour="source"]', favorite: '[data-tour="favorite"]',
    favorites: document.querySelector('.v-bottom-navigation') ? '.v-bottom-navigation [data-tour="favorites"]' : '.v-navigation-drawer [data-tour="favorites"]',
  };
  selector = targets[tour.stepId];
  if (['source', 'favorite'].includes(tour.stepId) && tour.detailVisible && !tour.detailOpen) selector = '[data-tour="detail-status"]';
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0) ?? null;
}

function scrollToTarget() {
  const element = target();
  if (element) {
    // 固定ヘッダー・ナビ以外は、画面を実際にスクロールして対象を見せる。
    if (!['collect', 'favorites'].includes(tour.stepId)) {
      element.scrollIntoView({ block: window.innerWidth < 600 ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
    }
  }
  schedulePosition();
}

function position() {
  frame = 0;
  if (!tour.running) return;
  const element = target();
  if (element !== observedTarget) {
    if (observedTarget) observer?.unobserve(observedTarget);
    if (element) observer?.observe(element);
    observedTarget = element;
  }
  const bounds = element?.getBoundingClientRect();
  const view = window.visualViewport;
  const top = view?.offsetTop ?? 0;
  const left = view?.offsetLeft ?? 0;
  const width = view?.width ?? window.innerWidth;
  const height = view?.height ?? window.innerHeight;
  const gap = 16;
  const panelWidth = Math.min(376, width - 24);
  const panelHeight = panel.value?.getBoundingClientRect().height ?? 340;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  if (!bounds || bounds.bottom < top || bounds.top > top + height || bounds.right < left || bounds.left > left + width) {
    rect.value = null;
    panelStyle.value = { width: `${panelWidth}px`, top: `${top + height - Math.min(panelHeight, height - 24) - 12}px`, left: `${left + (width - panelWidth) / 2}px`, maxHeight: `${height - 24}px` };
    return;
  }
  const r = {
    top: Math.max(top + 4, bounds.top - 6), left: Math.max(left + 4, bounds.left - 6),
    width: Math.min(bounds.right + 6, left + width - 4) - Math.max(left + 4, bounds.left - 6),
    height: Math.min(bounds.bottom + 6, top + height - 4) - Math.max(top + 4, bounds.top - 6),
  };
  rect.value = r;
  let x = left + (width - panelWidth) / 2;
  let y: number;
  let maxPanelHeight = height - 24;
  if (width >= 700 && r.left + r.width + gap + panelWidth < left + width - 12) {
    x = r.left + r.width + gap;
    y = clamp(r.top, top + 12, top + height - panelHeight - 12);
  } else if (width >= 700 && r.left - gap - panelWidth > left + 12) {
    x = r.left - gap - panelWidth;
    y = clamp(r.top, top + 12, top + height - panelHeight - 12);
  } else {
    x = clamp(r.left, left + 12, left + width - panelWidth - 12);
    const spaceBelow = top + height - r.top - r.height;
    const spaceAbove = r.top - top;
    const below = spaceBelow >= panelHeight + gap + 12
      || (spaceAbove < panelHeight + gap + 12 && spaceBelow >= spaceAbove);
    maxPanelHeight = Math.max(100, (below ? spaceBelow : spaceAbove) - gap - 12);
    y = below ? r.top + r.height + gap : r.top - gap - Math.min(panelHeight, maxPanelHeight);
  }
  panelStyle.value = { width: `${panelWidth}px`, top: `${Math.max(top + 12, y)}px`, left: `${x}px`, maxHeight: `${maxPanelHeight}px` };
}

function schedulePosition() {
  if (tour.running && !frame) frame = requestAnimationFrame(position);
}

function onFocus(event: FocusEvent) {
  if (event.target instanceof HTMLElement && event.target.matches('input, textarea')) focusedInput.value = true;
  schedulePosition();
}

function onKey(event: KeyboardEvent) {
  if (!tour.running || event.key !== 'Escape') return;
  if (document.querySelector('.v-menu.v-overlay--active')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  tour.pause();
}

watch(() => [tour.running, tour.index] as const, ([running], [wasRunning]) => {
  clearInterval(collectTimer);
  if (running) {
    void prepareStep();
    // 既に収集中の空DBでも、外部収集を再実行せず結果を待てる。
    if (tour.stepId === 'collect') collectTimer = setInterval(() => {
      if (!media.items.length && !media.loading) {
        void meta.refreshStats().catch(() => {});
        void media.refresh();
      }
    }, 5000);
  } else if (wasRunning) void restore();
});

watch(() => [media.loading, media.error, media.typeFilter, media.keyword, media.sort, route.name, media.total] as const, () => {
  if (!tour.running || preparing.value || media.loading || media.error) return;
  if (tour.stepId === 'type' && ['image', 'video', 'gif'].includes(media.typeFilter)) tour.confirm('type');
  if (tour.stepId === 'search' && media.keyword.trim()) tour.confirm('search');
  if (tour.stepId === 'sort' && media.sort === 'new') tour.confirm('sort');
  if (tour.stepId === 'favorites' && route.name === 'favorites') tour.confirm('favorites');
  schedulePosition();
});
watch(() => [tour.detailOpen, tour.detailVisible] as const, async () => { await nextTick(); scrollToTarget(); });
watch(panel, (element) => { if (element) observer?.observe(element); });

onMounted(() => {
  tour.initialize();
  observer = new ResizeObserver(schedulePosition);
  observer.observe(document.body);
  window.addEventListener('scroll', schedulePosition, true);
  window.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
  document.addEventListener('focusin', onFocus);
  window.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => {
  ++generation;
  clearInterval(collectTimer);
  cancelAnimationFrame(frame);
  observer?.disconnect();
  window.removeEventListener('scroll', schedulePosition, true);
  window.removeEventListener('resize', schedulePosition);
  window.visualViewport?.removeEventListener('resize', schedulePosition);
  window.visualViewport?.removeEventListener('scroll', schedulePosition);
  document.removeEventListener('focusin', onFocus);
  window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <v-dialog :model-value="tour.welcome" max-width="560" aria-labelledby="tutorial-welcome-title" @update:model-value="(value) => !value && tour.dismiss()">
    <v-card class="tour-welcome" color="surface">
      <div class="d-flex align-center justify-space-between px-6 pt-5">
        <span class="tour-eyebrow">MATSURISCOPE / 操作ガイド</span>
        <v-btn icon="mdi-close" variant="text" size="small" aria-label="使い方を閉じる" @click="tour.dismiss()" />
      </div>
      <v-card-text class="px-6 pt-3 pb-2">
        <h2 id="tutorial-welcome-title" class="text-h5 font-weight-bold mb-3">画面を触って、使い方を覚える</h2>
        <p class="text-body-2 text-medium-emphasis mb-5">ボタンの場所を光で示し、実際の操作結果を確認しながら進む8ステップです。</p>
        <div class="tour-roadmap">
          <div v-for="(item, index) in [{icon: 'mdi-image-search-outline', title: '集める・探す', text: '収集 → 種類 → 検索 → 並び順'}, {icon: 'mdi-star-check-outline', title: '確かめる・見返す', text: '詳細 → 出典 → 保存 → お気に入り'}]" :key="index" class="tour-roadmap-item">
            <v-icon :icon="item.icon" color="primary" size="26" />
            <div><strong>{{ item.title }}</strong><div class="text-caption text-medium-emphasis mt-1">{{ item.text }}</div></div>
          </div>
        </div>
        <p class="text-caption text-medium-emphasis mt-4 mb-3">実データを使います。検索条件は終了時に元に戻し、練習で付けたお気に入りは保存します。収集は自分でボタンを押した場合だけ実行します。</p>
        <v-alert v-if="tour.started && !tour.completed" type="info" variant="tonal" density="compact" class="mb-3">
          {{ savedCount }} / {{ tutorialSteps.length }} ステップを確認済み。「{{ tour.step.label }}」から再開できます。
        </v-alert>
      </v-card-text>
      <v-card-actions class="px-6 pb-5 flex-wrap ga-2">
        <v-btn variant="text" @click="tour.dismiss()">今は閉じる</v-btn>
        <v-spacer />
        <v-btn v-if="tour.started && !tour.completed" variant="text" size="small" :disabled="preparing" @click="start(false)">最初から</v-btn>
        <v-btn color="primary" variant="flat" :disabled="preparing" @click="start(tour.started && !tour.completed)">
          {{ tour.started && !tour.completed ? '続きから再開' : '操作ツアーを始める' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <Teleport to="body">
    <div v-if="tour.running" class="tutorial-layer v-theme--matsuri">
      <div v-if="rect" class="tour-spotlight" :style="{top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px`}" aria-hidden="true" />
      <div v-else class="tour-dim" aria-hidden="true" />
      <section ref="panel" class="tour-panel" :class="{'tour-panel--compact': compact}" :style="panelStyle" tabindex="-1" role="dialog" aria-modal="false" aria-labelledby="tutorial-title" aria-describedby="tutorial-task" data-tutorial-panel>
        <div class="tour-panel-header">
          <span class="tour-eyebrow">操作ツアー <strong>{{ tour.index + 1 }} / {{ tutorialSteps.length }}</strong></span>
          <v-btn icon="mdi-close" size="x-small" variant="text" aria-label="中断して閉じる" title="中断して閉じる（Esc）" @click="tour.pause()" />
        </div>
        <v-progress-linear :model-value="((tour.index + 1) / tutorialSteps.length) * 100" color="primary" height="3" />
        <div class="tour-panel-content">
          <div class="d-flex align-center ga-2 mb-3">
            <v-icon :icon="tour.step.icon" size="23" color="primary" />
            <h2 id="tutorial-title">{{ tour.step.title }}</h2>
          </div>
          <p v-if="!compact" class="tour-description">{{ content.text }}</p>
          <div id="tutorial-task" class="tour-task"><span class="tour-task-label">{{ tour.step.action ? 'やってみよう' : 'ここをチェック' }}</span>{{ content.task }}</div>
          <details v-if="!compact" class="tour-more">
            <summary>補足・注意点</summary>
            <p class="tour-tip">{{ content.tip }}</p>
          </details>
          <p class="tour-feedback" :class="{'tour-feedback--done': verified}" role="status" aria-live="polite">
            <v-icon v-if="verified" icon="mdi-check-circle-outline" size="16" class="mr-1" />{{ feedback }}
          </p>
          <v-btn v-if="media.error" variant="text" size="small" @click="media.refresh()">読み込みを再試行</v-btn>
          <v-btn v-if="['source', 'favorite'].includes(tour.stepId) && !tour.detailOpen && media.items.length" variant="tonal" color="primary" size="small" @click="tour.requestedDetailId = tour.selectedId ?? media.items[0]!.id">詳細を開き直す</v-btn>
          <button v-if="!rect && !preparing" class="tour-text-button" @click="scrollToTarget">操作する場所を表示</button>
        </div>
        <div class="tour-panel-actions">
          <v-btn variant="text" size="small" :disabled="tour.index === 0 || preparing" @click="tour.back()">戻る</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="flat" size="small" :disabled="!tour.canAdvance || preparing" @click="tour.next()">{{ tour.index === tutorialSteps.length - 1 ? 'ツアーを終える' : '次へ' }}</v-btn>
        </div>
        <div class="tour-panel-footer">
          <button v-if="!tour.canAdvance" class="tour-text-button" :disabled="preparing" @click="tour.next(true)">この操作は後で試す</button>
          <span v-else>途中で閉じても、続きから再開できます</span>
          <span v-if="!tour.storageAvailable">このブラウザでは進行状況を保存できません</span>
        </div>
      </section>
    </div>
  </Teleport>

  <v-dialog :model-value="tour.summary" max-width="520" aria-labelledby="tutorial-summary-title" @update:model-value="(value) => !value && (tour.summary = false)">
    <v-card class="tour-welcome" color="surface">
      <v-card-text class="pa-6">
        <v-icon :icon="tour.completed ? 'mdi-check-decagram-outline' : 'mdi-bookmark-outline'" size="42" color="primary" class="mb-4" />
        <h2 id="tutorial-summary-title" class="text-h5 font-weight-bold mb-2">{{ tour.completed ? 'ひと通りの使い方を体験できました' : '未体験の操作は、後から続けられます' }}</h2>
        <p class="text-body-2 text-medium-emphasis mb-4">{{ savedCount }} / {{ tutorialSteps.length }} ステップを確認しました。検索条件と並び順は開始前に戻し、お気に入りは残しています。</p>
        <ul class="tour-results">
          <li v-for="step in tutorialSteps" :key="step.id">
            <v-icon :icon="tour.verified.includes(step.id) ? 'mdi-check-circle' : 'mdi-minus-circle-outline'" :color="tour.verified.includes(step.id) ? 'success' : 'medium-emphasis'" size="19" />
            {{ step.label }}<span v-if="!tour.verified.includes(step.id)" class="text-caption text-medium-emphasis">未体験</span>
          </li>
        </ul>
        <p class="text-caption text-medium-emphasis mt-4">右上の「使い方を見る」から、いつでも再開・最初からやり直しができます。</p>
      </v-card-text>
      <v-card-actions class="px-6 pb-5"><v-spacer /><v-btn color="primary" variant="flat" :disabled="preparing" @click="tour.summary = false">一覧に戻る</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.tour-welcome { border: 1px solid rgba(34, 211, 238, .25); border-radius: 18px; }
.tour-eyebrow { font-size: .7rem; color: #67e8f9; letter-spacing: .08em; font-weight: 700; }
.tour-roadmap { display: grid; gap: 10px; }
.tour-roadmap-item { display: flex; gap: 14px; align-items: center; padding: 14px; background: rgba(34, 211, 238, .05); border: 1px solid rgba(34, 211, 238, .12); border-radius: 10px; }
.tutorial-layer { position: fixed; inset: 0; z-index: 3100; pointer-events: none; color: rgb(var(--v-theme-on-surface)); }
.tour-spotlight { position: fixed; border: 2px solid #22d3ee; border-radius: 10px; box-shadow: 0 0 0 9999px rgba(2, 6, 17, .72), 0 0 22px rgba(34, 211, 238, .4); }
.tour-dim { position: fixed; inset: 0; background: rgba(2, 6, 17, .55); }
.tour-panel { position: fixed; display: flex; flex-direction: column; pointer-events: auto; overflow: hidden; background: rgb(var(--v-theme-surface)); border: 1px solid rgba(34, 211, 238, .4); border-radius: 14px; box-shadow: 0 16px 60px rgba(0, 0, 0, .5); outline: none; }
.tour-panel:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
.tour-panel-header { padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; }
.tour-panel-content { padding: 18px 18px 4px; min-height: 0; overflow-y: auto; }
.tour-panel h2 { font-size: 1rem; font-weight: 700; line-height: 1.5; }
.tour-description { font-size: .83rem; line-height: 1.7; margin-bottom: 14px; color: #cbd5e1; }
.tour-task { font-size: .86rem; line-height: 1.7; padding: 12px; border-radius: 8px; border-left: 3px solid #22d3ee; background: rgba(34, 211, 238, .07); }
.tour-task-label { display: block; font-size: .68rem; color: #67e8f9; font-weight: 700; margin-bottom: 4px; }
.tour-tip { font-size: .74rem; color: #94a3b8; line-height: 1.7; margin: 12px 0; }
.tour-more { margin-top: 12px; font-size: .73rem; color: #94a3b8; }
.tour-more summary { cursor: pointer; }
.tour-feedback { font-size: .74rem; line-height: 1.6; color: #94a3b8; margin: 12px 0 4px; }
.tour-feedback--done { color: #6ee7b7; }
.tour-panel-actions { display: flex; padding: 12px 16px 8px; gap: 8px; }
.tour-panel-footer { display: flex; flex-wrap: wrap; justify-content: center; padding: 4px 16px 14px; font-size: .67rem; color: #94a3b8; }
.tour-panel-header, .tour-panel-actions, .tour-panel-footer, .tour-panel > .v-progress-linear { flex-shrink: 0; }
.tour-text-button { font-size: .72rem; color: #94a3b8; text-decoration: underline; cursor: pointer; }
.tour-text-button:focus-visible { outline: 2px solid #22d3ee; outline-offset: 3px; }
.tour-results { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.tour-results li { display: flex; align-items: center; gap: 8px; font-size: .86rem; }
.tour-panel--compact .tour-panel-content { padding-top: 10px; }
@media (max-width: 600px) {
  .tour-panel-header { padding: 8px 14px; }
  .tour-panel-content { padding: 12px 14px 0; }
  .tour-description { margin-bottom: 10px; font-size: .78rem; }
  .tour-task { font-size: .8rem; padding: 10px; }
  .tour-tip { font-size: .7rem; margin: 8px 0; }
  .tour-feedback { font-size: .7rem; margin-top: 8px; }
}
</style>

<style>
[data-tour] { scroll-margin-top: 90px; }
body:has(.tutorial-layer) .v-menu { z-index: 3200 !important; }
</style>
