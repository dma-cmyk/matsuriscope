<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { useMediaStore, useMetaStore, type PeriodKey, type SortKey, type TypeFilter } from '../stores';

const media = useMediaStore();
const meta = useMetaStore();
const display = useDisplay();
const isMobile = computed(() => display.smAndDown.value);
const showFilters = ref(false);

const typeChips: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'image', label: '画像' },
  { value: 'video', label: '動画' },
  { value: 'gif', label: 'GIF' },
  { value: 'favorite', label: 'お気に入り' },
];

const sortItems: { value: SortKey; label: string }[] = [
  { value: 'ikioi', label: '勢い順' },
  { value: 'buzz', label: '話題スコア順' },
  { value: 'new', label: '新着順' },
  { value: 'res', label: 'レス数順' },
];

const periodItems: { value: PeriodKey; label: string }[] = [
  { value: '', label: '全期間' },
  { value: '24h', label: '24時間' },
  { value: '3d', label: '3日' },
  { value: '7d', label: '7日' },
];

const boardItems = computed(() => [
  { value: '', label: '全板' },
  ...meta.boards
    .filter((b) => b.enabled === 1)
    .map((b) => ({ value: `${b.server}/${b.board_key}`, label: b.name })),
]);

const searchLocal = ref(media.keyword);
</script>

<template>
  <div class="filter-bar">
    <div class="d-flex align-center flex-wrap ga-2">
      <v-chip-group
        :model-value="media.typeFilter"
        mandatory
        selected-class="chip-active"
        @update:model-value="(v) => media.setFilter({ typeFilter: v as TypeFilter })"
      >
        <v-chip v-for="c in typeChips" :key="c.value" :value="c.value" size="small" variant="outlined">
          {{ c.label }}
        </v-chip>
      </v-chip-group>
      <v-spacer />
      <v-btn
        v-if="isMobile"
        size="small"
        variant="tonal"
        icon="mdi-tune"
        @click="showFilters = !showFilters"
      />
      <template v-if="!isMobile || showFilters">
        <v-select
          :model-value="media.sort"
          :items="sortItems"
          item-title="label"
          item-value="value"
          density="compact"
          variant="outlined"
          hide-details
          prepend-inner-icon="mdi-fire"
          class="select-sort"
          @update:model-value="(v) => media.setFilter({ sort: v as SortKey })"
        />
        <v-select
          :model-value="media.board"
          :items="boardItems"
          item-title="label"
          item-value="value"
          density="compact"
          variant="outlined"
          hide-details
          class="select-board"
          @update:model-value="(v) => media.setFilter({ board: String(v) })"
        />
        <v-select
          :model-value="media.period"
          :items="periodItems"
          item-title="label"
          item-value="value"
          density="compact"
          variant="outlined"
          hide-details
          class="select-period"
          @update:model-value="(v) => media.setFilter({ period: v as PeriodKey })"
        />
      </template>
      <v-text-field
        v-if="isMobile"
        v-model="searchLocal"
        density="compact"
        variant="outlined"
        placeholder="検索..."
        prepend-inner-icon="mdi-magnify"
        hide-details
        clearable
        class="search-mobile"
        @keyup.enter="media.setFilter({ keyword: searchLocal })"
        @click:clear="media.setFilter({ keyword: '' })"
      />
    </div>
  </div>
</template>

<style scoped>
.select-sort {
  max-width: 150px;
}
.select-board {
  max-width: 160px;
}
.select-period {
  max-width: 120px;
}
.chip-active {
  background: rgba(34, 211, 238, 0.18) !important;
  border-color: #22d3ee !important;
  color: #22d3ee !important;
}
.search-mobile {
  flex-basis: 100%;
}
</style>
