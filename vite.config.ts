import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // IMPORTANT: Change '/test-me/' to the name of your GitHub repository.
  // For example, if your repo is https://github.com/user/my-quiz-app,
  // set base: '/my-quiz-app/'
  base: '/test-me/',
})
