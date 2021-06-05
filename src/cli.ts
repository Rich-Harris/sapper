import * as fs from 'fs';
import * as path from 'path';
import sade from 'sade';
import colors from 'kleur';
import * as pkg from '../package.json';
import { elapsed, repeat, left_pad, format_milliseconds } from './utils';
import { InvalidEvent, ErrorEvent, FatalEvent, BuildEvent, ReadyEvent } from './interfaces';

const prog = sade('sapper').version(pkg.version);

if (process.argv[2] === 'start') {
	// remove this in a future version
	console.error(colors.bold().red('"sapper start" has been removed'));
	console.error('Use "node [build_dir]" instead');
	process.exit(1);
}

const start = Date.now();

prog.command('dev')
	.describe('Start a development server')
	.option('-p, --port', 'Specify a port')
	.option('-o, --open', 'Open a browser window')
	.option('--dev-port', 'Specify a port for development server')
	.option('--hot', 'Use hot module replacement (requires webpack)', true)
	.option('--live', 'Reload on changes if not using --hot', true)
	.option('--bundler', 'Specify a bundler (rollup or webpack)')
	.option('--cwd', 'Current working directory', '.')
	.option('--src', 'Source directory', 'src')
	.option('--routes', 'Routes directory', 'src/routes')
	.option('--static', 'Static files directory', 'static')
	.option('--output', 'Sapper intermediate file output directory', 'src/node_modules/@sapper')
	.option('--build-dir', 'Development build directory', '__sapper__/dev')
	.option('--ext', 'Custom Route Extension', '.svelte .html')
	.action(async (opts: {
		port: number;
		open: boolean;
		'dev-port': number;
		live: boolean;
		hot: boolean;
		bundler?: 'rollup' | 'webpack';
		cwd: string;
		src: string;
		routes: string;
		static: string;
		output: string;
		'build-dir': string;
		ext: string;
	}) => {
		const { dev } = await import('./api/dev');

		try {
			const watcher = dev({
				cwd: opts.cwd,
				src: opts.src,
				routes: opts.routes,
				static: opts.static,
				output: opts.output,
				dest: opts['build-dir'],
				port: opts.port,
				'dev-port': opts['dev-port'],
				live: opts.live,
				hot: opts.hot,
				bundler: opts.bundler,
				ext: opts.ext
			});

			let first = true;

			watcher.on('stdout', data => {
				process.stdout.write(data);
			});

			watcher.on('stderr', data => {
				process.stderr.write(data);
			});

			watcher.on('ready', async (event: ReadyEvent) => {
				if (first) {
					console.log(colors.bold().cyan(`> Listening on http://localhost:${event.port}`));
					if (opts.open) {
						const { exec } = await import('child_process');
						exec(`open http://localhost:${event.port}`);
					}
					first = false;
				}
			});

			watcher.on('invalid', (event: InvalidEvent) => {
				const changed = event.changed.map(filename => path.relative(process.cwd(), filename)).join(', ');
				console.log(`\n${colors.bold().cyan(changed)} changed. Rebuilding...`);
			});

			watcher.on('error', (event: ErrorEvent) => {
				const { type, error } = event;

				console.log(colors.bold().red(`✗ ${type}`));

				if (error.loc && error.loc.file) {
					console.log(colors.bold(`${path.relative(process.cwd(), error.loc.file)} (${error.loc.line}:${error.loc.column})`));
				}

				console.log(colors.red(event.error.message));
				if (error.frame) console.log(error.frame);
			});

			watcher.on('fatal', (event: FatalEvent) => {
				console.log(colors.bold().red(`> ${event.message}`));
				if (event.log) console.log(event.log);
			});

			watcher.on('build', (event: BuildEvent) => {
				if (event.errors.length) {
					console.log(colors.bold().red(`✗ ${event.type}`));

					event.errors.filter(e => !e.duplicate).forEach(error => {
						if (error.file) console.log(colors.bold(error.file));
						console.log(error.message);
					});

					const hidden = event.errors.filter(e => e.duplicate).length;
					if (hidden > 0) {
						console.log(`${hidden} duplicate ${hidden === 1 ? 'error' : 'errors'} hidden\n`);
					}
				} else if (event.warnings.length) {
					console.log(colors.bold().yellow(`• ${event.type}`));

					event.warnings.filter(e => !e.duplicate).forEach(warning => {
						if (warning.file) console.log(colors.bold(warning.file));
						console.log(warning.message);
					});

					const hidden = event.warnings.filter(e => e.duplicate).length;
					if (hidden > 0) {
						console.log(`${hidden} duplicate ${hidden === 1 ? 'warning' : 'warnings'} hidden\n`);
					}
				} else {
					console.log(`${colors.bold().green(`✔ ${event.type}`)} ${colors.gray(`(${format_milliseconds(event.duration)})`)}`);
				}
			});
		} catch (err) {
			console.log(colors.bold().red(`> ${err.message}`));
			console.log(colors.gray(err.stack));
			process.exit(1);
		}
	});

prog.command('build [dest]')
	.describe('Create a production-ready version of your app')
	.option('-p, --port', 'Default of process.env.PORT', '3000')
	.option('--bundler', 'Specify a bundler (rollup or webpack, blank for auto)')
	.option('--legacy', 'Create separate legacy build')
	.option('--cwd', 'Current working directory', '.')
	.option('--src', 'Source directory', 'src')
	.option('--routes', 'Routes directory', 'src/routes')
	.option('--output', 'Sapper intermediate file output directory', 'src/node_modules/@sapper')
	.option('--ext', 'Custom page route extensions (space separated)', '.svelte .html')
	.example('build custom-dir -p 4567')
	.action(async (dest = '__sapper__/build', opts: {
		port: string;
		legacy: boolean;
		bundler?: 'rollup' | 'webpack';
		cwd: string;
		src: string;
		routes: string;
		output: string;
		ext: string;
	}) => {
		console.log('> Building...');

		const root = process.cwd();

		try {
			await _build(opts.bundler, opts.legacy, opts.cwd, root, opts.src, opts.routes, opts.output, dest, opts.ext);

			const launcher = path.resolve(opts.cwd, dest, 'index.js');

			fs.writeFileSync(launcher, `
				// generated by sapper build at ${new Date().toISOString()}
				process.env.NODE_ENV = process.env.NODE_ENV || 'production';
				process.env.PORT = process.env.PORT || ${opts.port || 3000};

				console.log('Starting server on port ' + process.env.PORT);
				require('./server/server.js');
			`.replace(/^\t+/gm, '').trim());

			console.error(`\n> Finished in ${elapsed(start)}. Type ${colors.bold().cyan(`node ${path.join(opts.cwd, dest)}`)} to run the app.`);
		} catch (err) {
			console.log(`${colors.bold().red(`> ${err.message}`)}`);
			console.log(colors.gray(err.stack));
			process.exit(1);
		}
	});

prog.command('export [dest]')
	.describe('Export your app as static files (if possible)')
	.option('--build', '(Re)build app before exporting', true)
	.option('--basepath', 'Specify a base path')
	.option('--host', 'Host header to use when crawling site')
	.option('--concurrent', 'Concurrent requests', 8)
	.option('--timeout', 'Milliseconds to wait for a page (--no-timeout to disable)', 5000)
	.option('--legacy', 'Creates an additional build, served only to legacy browsers')
	.option('--bundler', 'Specify a bundler (rollup or webpack, blank for auto)')
	.option('--cwd', 'Current working directory', '.')
	.option('--src', 'Source directory', 'src')
	.option('--routes', 'Routes directory', 'src/routes')
	.option('--static', 'Static files directory', 'static')
	.option('--output', 'Sapper intermediate file output directory', 'src/node_modules/@sapper')
	.option('--build-dir', 'Intermediate build directory', '__sapper__/build')
	.option('--ext', 'Custom page route extensions (space separated)', '.svelte .html')
	.option('--entry', 'Custom entry points (space separated)', '/')
	.action(async (dest = '__sapper__/export', opts: {
		build: boolean;
		legacy: boolean;
		bundler?: 'rollup' | 'webpack';
		basepath?: string;
		host?: string;
		concurrent: number;
		timeout: number | false;
		cwd: string;
		src: string;
		routes: string;
		static: string;
		output: string;
		'build-dir': string;
		ext: string;
		entry: string;
	}) => {
		try {
			if (opts.build) {
				console.log('> Building...');
				await _build(opts.bundler, opts.legacy, opts.cwd, opts.cwd, opts.src, opts.routes, opts.output, opts['build-dir'], opts.ext);
				console.error(`\n> Built in ${elapsed(start)}`);
			}

			const { export: _export } = await import('./api/export');
			const { default: pb } = await import('pretty-bytes');

			await _export({
				cwd: opts.cwd,
				static: opts.static,
				build_dir: opts['build-dir'],
				export_dir: dest,
				basepath: opts.basepath,
				host_header: opts.host,
				timeout: opts.timeout,
				concurrent: opts.concurrent,
				entry: opts.entry,

				oninfo: event => {
					console.log(colors.bold().cyan(`> ${event.message}`));
				},

				onfile: event => {
					const size_color = event.size > 150000 ? colors.bold().red : event.size > 50000 ? colors.bold().yellow : colors.bold().gray;
					const size_label = size_color(left_pad(pb(event.size), 10));

					const file_label = event.status === 200
						? event.file
						: colors.bold()[event.status >= 400 ? 'red' : 'yellow'](`(${event.status}) ${event.file}`);

					console.log(`${size_label}   ${file_label}`);
				}
			});

			console.error(`\n> Finished in ${elapsed(start)}. Type ${colors.bold().cyan(`npx serve ${path.join(opts.cwd, dest)}`)} to run the app.`);
		} catch (err) {
			console.error(colors.bold().red(`> ${err.message}`));
			process.exit(1);
		}
	});

prog.parse(process.argv, { unknown: (arg: string) => `Unknown option: ${arg}` });


async function _build(
	bundler: 'rollup' | 'webpack',
	legacy: boolean,
	cwd: string,
	root: string,
	src: string,
	routes: string,
	output: string,
	dest: string,
	ext: string
) {
	const { build } = await import('./api/build');

	await build({
		bundler,
		legacy,
		cwd,
		root,
		src,
		routes,
		dest,
		ext,
		output,
		oncompile: event => {
			let banner = `built ${event.type}`;
			let c = (txt: string) => colors.cyan(txt);

			const { warnings } = event.result;
			if (warnings.length > 0) {
				banner += ` with ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`;
				c = (txt: string) => colors.cyan(txt);
			}

			console.log();
			console.log(c(`┌─${repeat('─', banner.length)}─┐`));
			console.log(c(`│ ${colors.bold(banner)       } │`));
			console.log(c(`└─${repeat('─', banner.length)}─┘`));

			console.log(event.result.print());
		}
	});
}
