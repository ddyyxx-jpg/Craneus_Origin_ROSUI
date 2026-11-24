import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 5173 常被本机其他项目（galgame 服务端）占用，ROSUI 固定用 5180，端口被占直接失败而不是静默换端口。
export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, host: '127.0.0.1' },
});
