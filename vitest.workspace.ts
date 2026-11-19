import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'packages/*'],
    include: ['packages/*/test/**/*.test.ts'],
  },
})
