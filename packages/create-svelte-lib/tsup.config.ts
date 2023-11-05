import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/bin.ts'],
	outDir: 'dist',
	format: ['esm'],
	clean: true,
	splitting: false,
	sourcemap: false
});
