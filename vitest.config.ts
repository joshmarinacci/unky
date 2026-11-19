import { defineConfig } from 'vitest/config';

// Unit tests for the frontend's pure modules. The macOS desktop suite (tests/desktop) runs on WebdriverIO.
export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
    environment: 'node',
  },
});
