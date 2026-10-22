import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    env: { GIT_AUTHOR_NAME: 'Gitflare Tests', GIT_AUTHOR_EMAIL: 'tests@gitflare.invalid', GIT_COMMITTER_NAME: 'Gitflare Tests', GIT_COMMITTER_EMAIL: 'tests@gitflare.invalid' },
  },
});
