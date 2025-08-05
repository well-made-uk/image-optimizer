import { defineConfig } from 'vite';

export default defineConfig({
    root: '.', // index.html is at root
    publicDir: 'public',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    optimizeDeps: {
        // Prevent Vite from trying to pre-bundle this complex WASM+ESM library
        exclude: ['@jsquash/avif'],
    },
    assetsInclude: ['**/*.wasm'], // ensure .wasm is served correctly
    server: {
        open: true,
    },
});
