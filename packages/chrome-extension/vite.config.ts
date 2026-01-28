import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

/**
 * VibeJake Chrome Extension - Vite build config.
 * Builds DevTools panel with Vue, background script, and content script.
 */

// Plugin to copy static files after build
function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');

      // Ensure directories exist
      const dirs = [
        'src/devtools',
        'icons',
      ];
      dirs.forEach(dir => {
        const fullPath = resolve(distDir, dir);
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
        }
      });

      // Copy manifest.json
      copyFileSync(
        resolve(__dirname, 'manifest.json'),
        resolve(distDir, 'manifest.json')
      );

      // Copy HTML files
      copyFileSync(
        resolve(__dirname, 'src/devtools/devtools.html'),
        resolve(distDir, 'src/devtools/devtools.html')
      );
      copyFileSync(
        resolve(__dirname, 'src/devtools/panel.html'),
        resolve(distDir, 'src/devtools/panel.html')
      );

      // Copy icons
      copyFileSync(
        resolve(__dirname, 'icons/icon16.png'),
        resolve(distDir, 'icons/icon16.png')
      );
      copyFileSync(
        resolve(__dirname, 'icons/icon48.png'),
        resolve(distDir, 'icons/icon48.png')
      );
      copyFileSync(
        resolve(__dirname, 'icons/icon128.png'),
        resolve(distDir, 'icons/icon128.png')
      );
      copyFileSync(
        resolve(__dirname, 'icons/logo.svg'),
        resolve(distDir, 'icons/logo.svg')
      );

      console.log('Static files copied to dist/');
    }
  };
}

// Build content script separately as IIFE (no ES module imports)
const isContentBuild = process.env.BUILD_CONTENT === 'true';

export default defineConfig({
  plugins: isContentBuild ? [] : [vue(), copyStaticFiles()],
  build: {
    outDir: 'dist',
    emptyOutDir: !isContentBuild, // Don't empty on content build (runs second)
    rollupOptions: isContentBuild ? {
      // Content script build - IIFE format, no imports
      input: resolve(__dirname, 'src/content/index.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'src/content/index.js',
        inlineDynamicImports: true,
      },
    } : {
      // Main build - background, devtools, panel
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        devtools: resolve(__dirname, 'src/devtools/devtools.ts'),
        'panel-main': resolve(__dirname, 'src/devtools/panel-main.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          const name = chunkInfo.name;
          if (name === 'background') return 'src/background/index.js';
          if (name === 'devtools') return 'src/devtools/devtools.js';
          if (name === 'panel-main') return 'src/devtools/panel-main.js';
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
