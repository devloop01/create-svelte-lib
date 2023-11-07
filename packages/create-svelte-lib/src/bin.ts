#!/usr/bin/env node

import * as p from '@clack/prompts';
import { create as createSvelteKitApp } from 'create-svelte';
import type { Options as CreateSvelteKitOptions } from 'create-svelte/types/internal';
import { execa } from 'execa';
import { copy } from 'fs-extra';
import { Merger } from 'json-merger';
import { bold, cyan, grey, red } from 'kleur/colors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';

const print = console.log;

const { version } = JSON.parse(
	fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);

print(grey(`\ncreate-svelte-lib version ${version}\n`));

let cwd = process.argv[2] || '.';

const create = async () => {
	p.intro('Welcome!');

	if (cwd === '.') {
		const dir = await p.text({
			message: 'Where should we create your project?',
			placeholder: '  (hit Enter to use current directory)'
		});

		if (p.isCancel(dir)) process.exit(1);

		if (dir) cwd = dir;
	}

	if (fs.existsSync(cwd)) {
		if (fs.readdirSync(cwd).length > 0) {
			const force = await p.confirm({
				message: 'Directory not empty. Continue?',
				initialValue: false
			});

			// bail if `force` is `false` or the user cancelled with Ctrl-C
			if (force !== true) process.exit(1);
		}
	}

	const options = await p.group(
		{
			types: () =>
				p.select({
					message: 'Add type checking with TypeScript?',
					initialValue: 'checkjs',
					options: [
						{
							label: 'Yes, using JavaScript with JSDoc comments',
							value: 'checkjs'
						},
						{
							label: 'Yes, using TypeScript syntax',
							value: 'typescript'
						},
						{ label: 'No', value: 'null' }
					]
				}),

			features: () =>
				p.multiselect({
					message: 'Select additional options (use arrow keys/space bar)',
					required: false,
					options: [
						{
							value: 'eslint',
							label: 'Add ESLint for code linting'
						},
						{
							value: 'prettier',
							label: 'Add Prettier for code formatting'
						},
						{
							value: 'playwright',
							label: 'Add Playwright for browser testing'
						},
						{
							value: 'vitest',
							label: 'Add Vitest for unit testing'
						}
					]
				}),

			extras: () =>
				p.multiselect({
					message: 'Select extras (use arrow keys/space bar)',
					required: false,
					options: [
						{
							value: '@changesets/cli',
							label: '@changesets/cli',
							hint: 'Changesets setup for publishing packages'
						}
					]
				}),

			git: () =>
				p.confirm({
					message: 'Initialize a git repository?',
					initialValue: true
				}),

			packageManager: () =>
				p.select({
					message: 'Select a package manager',
					initialValue: 'npm',
					options: [
						{ label: 'npm', value: 'npm' },
						{ label: 'pnpm', value: 'pnpm' },
						{ label: 'yarn', value: 'yarn' }
					]
				}),

			install: ({ results }) =>
				p.confirm({
					message: `Install dependencies using ${results.packageManager ?? 'npm'}?`,
					initialValue: true
				})
		},
		{ onCancel: () => process.exit(1) }
	);

	const pkgManager = options.packageManager;

	const resolvePackageVersion = async (packageName: string, range = 'latest') => {
		try {
			const response = await request(
				`https://cdn.jsdelivr.net/npm/${packageName}@${range}/package.json`
			);
			const packageJson = (await response.body.json()) as { version: string };
			return `^${packageJson.version}`;
		} catch (error) {
			print(
				bold(red(`✘ Failed to resolve package version for ${packageName}, using ${range} instead`))
			);
			return range;
		}
	};

	// prettier-ignore
	const types = (options.types === 'null' ? null : options.types) as CreateSvelteKitOptions['types'];

	await createSvelteKitApp(cwd, {
		name: path.basename(path.resolve(cwd)),
		template: 'skeletonlib',
		types,
		prettier: options.features.includes('prettier'),
		eslint: options.features.includes('eslint'),
		playwright: options.features.includes('playwright'),
		vitest: options.features.includes('vitest')
	});

	// at this point, a new SvelteKit App is initialized in the `cwd` directory

	const merger = new Merger({});

	const svelteKitPkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));

	const spinner = p.spinner();
	spinner.start('Resolving package versions');

	const devDependencies = ['@changesets/cli'];

	async function resolveDeps(deps: string[]) {
		const resolvedDeps: Record<string, string> = {};

		for (const dep of deps) {
			if (options.extras.includes(dep)) {
				const resolvedVersion = await resolvePackageVersion(dep);
				resolvedDeps[dep] = resolvedVersion;
			}
		}

		return resolvedDeps;
	}

	const newPackageJson = {
		devDependencies: await resolveDeps(devDependencies),
		scripts: {}
	};

	const mergedPkg = merger.mergeObjects([svelteKitPkg, newPackageJson]);

	spinner.stop('Resolved package versions');

	fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(mergedPkg, null, 2));

	const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

	// Copy Templates
	if (options.types === 'typescript') {
		// handle typescript templates
		await copy(path.join(templatesDir, 'typescript'), cwd);
	} else {
		// handle javascript templates
		await copy(path.join(templatesDir, 'javascript'), cwd);
	}

	if (options.extras.includes('@changesets/cli')) {
		const spinner = p.spinner();
		try {
			spinner.start(`Initializing changesets`);
			await execa('npx', ['changeset', 'init'], { cwd, stdio: 'ignore' });
			spinner.stop(`Initialized changesets`);
		} catch (error) {
			spinner.stop(red('Failed to initialize changesets'));
			p.note('npx changeset init', 'Initialize changesets manually.');
		}
	}

	if (options.install) {
		const spinner = p.spinner();
		try {
			// Install dependencies
			spinner.start(`Installing dependencies using ${pkgManager}`);
			await execa(pkgManager, ['install'], { cwd, stdio: 'ignore' });
			spinner.stop(`Installed dependencies using ${pkgManager}`);
		} catch (error) {
			spinner.stop(red('Failed to install dependencies'));
			p.note('You can install them manually.');
			// This will show install instructions later on
			options.install = false;
		}
	}

	if (options.git) {
		// initialize git repository
		await execa('git', ['init'], { cwd, stdio: 'ignore' });
		await execa('git', ['add', '-A'], { cwd, stdio: 'ignore' });
		await execa('git', ['commit', '-m', 'Initial commit'], { cwd, stdio: 'ignore' });
	}

	p.outro('Your project is ready!');

	if (options.types === 'typescript') {
		print(bold('✔ Typescript'));
		print(cyan('  Inside Svelte components, use <script lang="ts">\n'));
	} else if (options.types === 'checkjs') {
		print(bold('✔ Type-checked JavaScript'));
		print(cyan('  https://www.typescriptlang.org/tsconfig#checkJs\n'));
	}

	if (options.features.includes('eslint')) {
		print(bold('✔ ESLint'));
		print(cyan('  https://github.com/sveltejs/eslint-plugin-svelte\n'));
	}

	if (options.features.includes('prettier')) {
		print(bold('✔ Prettier'));
		print(cyan('  https://prettier.io/docs/en/options.html'));
		print(cyan('  https://github.com/sveltejs/prettier-plugin-svelte#options\n'));
	}

	if (options.features.includes('playwright')) {
		print(bold('✔ Playwright'));
		print(cyan('  https://playwright.dev\n'));
	}

	if (options.features.includes('vitest')) {
		print(bold('✔ Vitest'));
		print(cyan('  https://vitest.dev\n'));
	}

	if (options.git) {
		print(bold('✔ Git'));
		print(cyan('  Initialized a git repository.'));
	}

	print('\nNext steps:');
	let step = 1;

	const relative = path.relative(process.cwd(), cwd);
	if (relative !== '') print(`  ${step++}: ${bold(cyan(`cd ${relative}`))}`);

	if (!options.install) print(`  ${step++}: ${bold(cyan(`${pkgManager} install`))}`);

	// prettier-ignore
	if (!options.git) print(`  ${step++}: ${bold(cyan('git init && git add -A && git commit -m "Initial commit"'))} (optional)`);

	print(`  ${step++}: ${bold(cyan(`${pkgManager} run dev -- --open`))}`);

	print(`\nTo close the dev server, hit ${bold(cyan('Ctrl-C'))}`);
};

create();
