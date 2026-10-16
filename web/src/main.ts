import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createVuetify } from 'vuetify';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';
import { router } from './router';

const vuetify = createVuetify({
  theme: {
    defaultTheme: 'matsuri',
    themes: {
      matsuri: {
        dark: true,
        colors: {
          background: '#0b0f1a',
          surface: '#111827',
          'surface-variant': '#1a2233',
          primary: '#22d3ee', // シアン
          secondary: '#a855f7', // パープル
          accent: '#f472b6',
          error: '#ef4444',
          info: '#38bdf8',
          success: '#34d399',
          warning: '#fbbf24',
          'on-background': '#e5e7eb',
          'on-surface': '#e5e7eb',
        },
      },
    },
  },
});

createApp(App).use(createPinia()).use(router).use(vuetify).mount('#app');
