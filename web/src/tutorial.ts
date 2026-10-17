import { defineStore } from 'pinia';

export const tutorialSteps = [
  { id: 'collect', label: '収集', title: 'まずは、実データの集め方', icon: 'mdi-refresh', action: false },
  { id: 'type', label: '種類', title: '画像・動画を切り替えてみよう', icon: 'mdi-image-multiple-outline', action: true },
  { id: 'search', label: '検索', title: 'キーワードで探してみよう', icon: 'mdi-magnify', action: true },
  { id: 'sort', label: '並び順', title: '新しい発見を先頭に', icon: 'mdi-sort', action: true },
  { id: 'detail', label: '詳細', title: '気になるカードを開こう', icon: 'mdi-arrow-expand', action: true },
  { id: 'source', label: '出典', title: '出典と「勢い」を確かめる', icon: 'mdi-open-in-new', action: false },
  { id: 'favorite', label: '保存', title: '気になったメディアを保存', icon: 'mdi-star-outline', action: true },
  { id: 'favorites', label: '見返す', title: '保存したメディアを見返そう', icon: 'mdi-star-check-outline', action: true },
] as const;

export type TutorialStepId = (typeof tutorialSteps)[number]['id'];
const STORAGE_KEY = 'matsuriscope:tutorial:v2';
const isStep = (id: unknown): id is TutorialStepId => tutorialSteps.some((step) => step.id === id);

export const useTutorialStore = defineStore('tutorial', {
  state: () => ({
    initialized: false,
    welcome: false,
    running: false,
    summary: false,
    started: false,
    completed: false,
    index: 0,
    verified: [] as TutorialStepId[],
    skipped: [] as TutorialStepId[],
    selectedId: null as number | null,
    selectedFavorite: null as boolean | null,
    detailOpen: false,
    detailVisible: false,
    requestedDetailId: null as number | null,
    storageAvailable: true,
  }),
  getters: {
    step: (state) => tutorialSteps[state.index] ?? tutorialSteps[0],
    stepId(): TutorialStepId { return this.step.id; },
    canAdvance(): boolean {
      if (this.stepId === 'source') return this.detailOpen;
      if (this.stepId === 'favorite' && !this.detailOpen) return false;
      return !this.step.action || this.verified.includes(this.stepId);
    },
  },
  actions: {
    initialize() {
      if (this.initialized) return;
      this.initialized = true;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (!saved || typeof saved !== 'object') throw new Error('invalid tutorial progress');
          this.verified = Array.isArray(saved.verified) ? [...new Set(saved.verified.filter(isStep))] as TutorialStepId[] : [];
          this.skipped = Array.isArray(saved.skipped) ? saved.skipped.filter(isStep).filter((id: TutorialStepId) => !this.verified.includes(id)) : [];
          this.index = Number.isInteger(saved.index) && saved.index >= 0 && saved.index < tutorialSteps.length ? saved.index : 0;
          this.started = saved.started === true;
          this.completed = this.verified.length === tutorialSteps.length;
          this.selectedId = Number.isSafeInteger(saved.selectedId) && saved.selectedId > 0 ? saved.selectedId : null;
          this.welcome = this.started && !this.completed;
          return;
        }
      } catch {
        // 壊れた保存内容や保存禁止でも、実画面の案内は使用できる。
      }
      this.welcome = true;
    },
    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          index: this.index, verified: this.verified, skipped: this.skipped,
          started: this.started, selectedId: this.selectedId,
        }));
      } catch {
        this.storageAvailable = false;
      }
    },
    open() {
      if (this.running) return;
      this.summary = false;
      this.welcome = true;
    },
    dismiss() {
      this.welcome = false;
      this.save();
    },
    start(resume: boolean) {
      if (!resume) {
        this.index = 0;
        this.verified = [];
        this.skipped = [];
        this.selectedId = null;
        this.selectedFavorite = null;
      }
      this.completed = false;
      this.started = true;
      this.welcome = false;
      this.summary = false;
      this.running = true;
      this.save();
    },
    confirm(id: TutorialStepId) {
      if (!this.running || id !== this.stepId) return;
      if (!this.verified.includes(id)) this.verified.push(id);
      this.skipped = this.skipped.filter((step) => step !== id);
      this.save();
    },
    next(skip = false) {
      if (!this.running || (!skip && !this.canAdvance)) return;
      if (skip) {
        if (!this.verified.includes(this.stepId) && !this.skipped.includes(this.stepId)) this.skipped.push(this.stepId);
      } else {
        this.confirm(this.stepId);
      }
      if (this.index < tutorialSteps.length - 1) this.index++;
      else {
        this.running = false;
        this.summary = true;
        this.completed = this.verified.length === tutorialSteps.length;
        if (!this.completed) this.index = tutorialSteps.findIndex((step) => !this.verified.includes(step.id));
      }
      this.save();
    },
    back() {
      if (this.index > 0) this.index--;
      this.save();
    },
    pause() {
      this.running = false;
      this.requestedDetailId = null;
      this.save();
    },
    detailOpening(id: number) {
      if (!this.running) return;
      this.detailVisible = true;
      this.detailOpen = false;
      this.selectedId = id;
      this.selectedFavorite = null;
    },
    detailLoaded(id: number, favorite: boolean) {
      if (!this.running || !['detail', 'source', 'favorite'].includes(this.stepId)) return;
      this.detailOpen = true;
      this.detailVisible = true;
      this.selectedId = id;
      this.selectedFavorite = favorite;
      if (this.stepId === 'detail') this.confirm('detail');
      if (this.stepId === 'favorite' && favorite) this.confirm('favorite');
      this.save();
    },
    detailClosed() {
      this.detailOpen = false;
      this.detailVisible = false;
      this.requestedDetailId = null;
    },
    favoriteSaved(id: number, favorite: boolean) {
      if (!this.running || id !== this.selectedId) return;
      this.selectedFavorite = favorite;
      if (this.stepId === 'favorite') {
        if (favorite) this.confirm('favorite');
        else {
          this.verified = this.verified.filter((step) => step !== 'favorite');
          this.save();
        }
      }
    },
  },
});
