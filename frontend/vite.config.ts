import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: [
      'antd/es/config-provider',
      'antd/es/theme',
      'antd/es/button',
      'antd/es/input',
      'antd/es/input-number',
      'antd/es/select',
      'antd/es/switch',
      'antd/es/checkbox',
      'antd/es/form',
      'antd/es/table',
      'antd/es/tabs',
      'antd/es/card',
      'antd/es/modal',
      'antd/es/badge',
      'antd/es/tag',
      'antd/es/progress',
      'antd/es/tooltip',
      'antd/es/alert',
      'antd/es/popconfirm',
      'antd/es/menu',
      'antd/es/layout',
      'antd/es/segmented',
      'antd/es/collapse',
      'antd/es/spin',
      'antd/es/empty',
      'antd/es/space',
      'antd/es/divider',
      'antd/es/statistic',
      'antd/es/steps',
      'antd/es/timeline',
      'antd/es/descriptions',
      'antd/es/dropdown',
      'antd/es/list',
      'antd/es/radio',
      'react',
      'react-dom',
    ],
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    watch: {
      usePolling: true,
      interval: 300,
      ignored: ['**/nohup.out'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  // `vite preview` 不会读取 server.proxy，必须单独配置，否则 /api 请求
  // 无法转发到后端 :3001，前端页面会收到 502/404。
  preview: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
