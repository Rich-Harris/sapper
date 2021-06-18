import * as path from 'path';
import color from 'kleur';
import relative from 'require-relative';
import { dependenciesForTree, DependencyTreeOptions } from 'rollup-dependency-tree';
import css_chunks from 'rollup-plugin-css-chunks';
import {
	NormalizedOutputOptions,
	OutputBundle,
	OutputChunk,
	Plugin,
	PluginContext,
	RenderedChunk,
	RollupError
} from 'rollup';
import { CompileResult } from './interfaces';
import RollupResult from './RollupResult';

const stderr = console.error.bind(console);
const INJECT_STYLES_NAME = 'inject_styles';
const INJECT_STYLES_ID = 'inject_styles.js';

let rollup: any;

function printTimings(timings: {[event: string]: [number, number, number]}) {
	for (const [key, info] of Object.entries(timings)) {
		console.info(`${key} took ${info[0].toFixed(0)}ms`);
	}
}

const inject_styles = `
export default function(files) {
	return Promise.all(files.map(function(file) { return new Promise(function(fulfil, reject) {
		var href = new URL(file, import.meta.url);
		var baseURI = document.baseURI;

		if (!baseURI) {
			var baseTags = document.getElementsByTagName('base');
			baseURI = baseTags.length ? baseTags[0].href : document.URL;
		}

		var relative = ('' + href).substring(baseURI.length);
		var link = document.querySelector('link[rel=stylesheet][href="' + relative + '"]')
			|| document.querySelector('link[rel=stylesheet][href="' + href + '"]');
		if (!link) {
			link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = href;
			link.onload = link.onerror = fulfil;
			document.head.appendChild(link);
		} else {
			fulfil();
		}
	})}));
};`.trim();

const get_entry_point_output_chunk = (bundle: OutputBundle, entry_point?: string) => {
	if (entry_point === undefined) {
		throw new Error('Internal error: entry_point cannot be undefined');
	}

	let entry_point_output_chunk: OutputChunk;
	for (const chunk of Object.values(bundle)) {
		if ((chunk as OutputChunk).facadeModuleId === entry_point) {
			entry_point_output_chunk = chunk as OutputChunk;
		}
	}

	if (!entry_point_output_chunk) {
		throw new Error(`Internal error: No chunk for entry point: ${entry_point} in: ${Object.keys(bundle)}`);
	}

	if (entry_point_output_chunk.type !== 'chunk') {
		throw new Error(`Internal error: Wrong type for entry point chunk: ${entry_point} in: ${Object.keys(bundle)}`);
	}

	return entry_point_output_chunk;
};

const find_css = (chunk: RenderedChunk, bundle: OutputBundle) => {
	const css_files = new Set<string>();
	const visited = new Set<RenderedChunk>();

	const recurse = (c: RenderedChunk) => {
		if (visited.has(c)) return;
		visited.add(c);

		if (c.imports) {
			c.imports.forEach(file => {
				if (file.endsWith('.css')) {
					css_files.add(file);
				} else {
					const imported_chunk = <OutputChunk>bundle[file];
					if (imported_chunk) {
						recurse(imported_chunk);
					}
				}
			});
		}
	};

	recurse(chunk);
	return Array.from(css_files);
};

export default class RollupCompiler {
	_: Promise<any>;
	_oninvalid: (filename: string) => void;
	_start: number;
	js_main: string | null;
	css_main: string[];
	warnings: any[];
	errors: any[];
	chunks: RenderedChunk[];
	css_files: Record<string, string>;
	dependencies: Record<string, string[]>;
	routes: string;

	constructor(config: any, routes: string) {
		this._ = this.get_config(config);
		this.js_main = null;
		this.css_main = [];
		this.warnings = [];
		this.errors = [];
		this.chunks = [];
		this.css_files = {};
		this.dependencies = {};
		this.routes = routes;
	}

	async get_config(mod: any) {

		const onwarn = mod.onwarn || ((warning: any, handler: (warning: any) => void) => {
			handler(warning);
		});

		mod.onwarn = (warning: any) => {
			onwarn(warning, (warn: any) => {
				this.warnings.push(warn);
			});
		};

		let entry_point: string;

		if (typeof mod.input === 'string') {
			entry_point = mod.input;
		} else {
			const inputs: Array<{alias: string, file: string}> = [];
			if (Array.isArray(mod.input)) {
				inputs.push(...mod.input.map(file => ({file, alias: file})));
			} else {
				for (const alias in mod.input) {
					inputs.push({file: mod.input[alias], alias});
				}
			}
			entry_point = inputs[0].file;
		}

		const that = this;

		// Don't add css_chunks plugin to service worker
		if (mod.output.dir) {
			// TODO this is hacky. refactor out into an external rollup plugin
			(mod.plugins || (mod.plugins = [])).push(css_chunks({
				entryFileNames: '[name]-[hash].css'
			}));
		}
		if (!/[\\/]client\./.test(entry_point)) {
			return mod;
		}

		/**
		 * Finds dynamic imports and rewrites them to import the component and its CSS in parallel
		 * This is somewhat similar to rollup-plugin-hoist-import-deps in that it loads static imports as soon as possible
		 */
		const css_injection: Plugin = {
			name: 'sapper-css-injection',
			buildStart(this: PluginContext): void {
				this.emitFile({
					type: 'chunk',
					id: INJECT_STYLES_ID,
					name: INJECT_STYLES_NAME,
					preserveSignature: 'allow-extension'
				});
			},
			load(id: string) {
				return id === INJECT_STYLES_ID ? inject_styles : null;
			},
			resolveId(importee: string) {
				return importee === INJECT_STYLES_ID ? INJECT_STYLES_ID : null;
			},
			renderDynamicImport({ targetModuleId }) {
				if (targetModuleId) {
					return {
						left: 'Promise.all([import(',
						right: `), ___SAPPER_CSS_INJECTION___${Buffer.from(targetModuleId).toString('hex')}___]).then(function(x) { return x[0]; })`
					};
				} else {
					return {
						left: 'import(',
						right: ')'
					};
				}
			},
			async generateBundle(this: PluginContext, options: NormalizedOutputOptions, bundle: OutputBundle): Promise<void> {

				const inject_styles_file = Object.keys(bundle).find(f => f.startsWith('inject_styles'));

				let has_css = false;
				for (const name in bundle) {
					const chunk = <OutputChunk>bundle[name];

					let chunk_has_css = false;

					if (chunk.code) {
						chunk.code = chunk.code.replace(/___SAPPER_CSS_INJECTION___([0-9a-f]+)___/g, (m, id) => {
							id = Buffer.from(id, 'hex').toString();
							const target = <OutputChunk>Object.values(bundle)
								.find(c => (<OutputChunk>c).modules && (<OutputChunk>c).modules[id]);

							if (target) {
								const css_files = find_css(target, bundle);
								if (css_files.length > 0) {
									chunk_has_css = true;
									return `__inject_styles(${JSON.stringify(css_files)})`;
								}
							}

							return '';
						});

						if (chunk_has_css) {
							has_css = true;
							chunk.code += `\nimport __inject_styles from './${inject_styles_file}';`;
						}
					}
				}

				if (!has_css) {
					delete bundle[inject_styles_file];
				}
			}
		};

		/**
		 * A read-only plugin used to gather information for the creation of the build.json manifest
		 */
		const sapper_internal: Plugin = {
			name: 'sapper-internal',
			async generateBundle(this: PluginContext, options: NormalizedOutputOptions, bundle: OutputBundle): Promise<void> {

				function is_route(file_path: string) {
					return file_path.includes(that.routes) && !file_path.endsWith('.css');
				}

				function js_deps(chunk: RenderedChunk, opts?: DependencyTreeOptions) {
					return Array.from(dependenciesForTree(chunk, that.chunks, opts));
				}

				// Store the chunks for later use
				Object.values(bundle)
					.filter(c => c.type === 'chunk')
					.forEach(c => that.chunks.push(<OutputChunk>c));

				// Store the build dependencies so that we can create build.json
				const dependencies = {};

				// It's hacky for the plugin to have to be aware of the style injection plugin
				// However, there doesn't appear to be any more generic way of handling it
				// https://github.com/rollup/rollup/issues/3790
				let inject_styles_file: string;
				for (const key of Object.keys(bundle)) {
					if (key.startsWith('inject_styles')) {
						inject_styles_file = key;
					}
				}

				// We need to handle the entry point separately
				// If there's a single page and preserveEntrySignatures is false then Rollup will
				// put everything in the entry point chunk (client.hash.js)
				// In that case we can't look it up by route, but still want to include it
				const entry_chunk = get_entry_point_output_chunk(bundle, entry_point);
				that.js_main = entry_chunk.fileName;

				// We consider the dependencies of the entry chunk as well when finding the CSS in
				// case preserveEntrySignatures is true and there are multiple chunks
				const entry_css = find_css(entry_chunk, bundle);
				that.css_main = entry_css && entry_css.length ? entry_css : undefined;

				// Routes dependencies
				function add_dependencies(chunk: RenderedChunk) {
					for (const module of Object.keys(chunk.modules)) {
						if (is_route(module)) {
							let js_dependencies = js_deps(chunk,
								{ walk: ctx => !ctx.dynamicImport && ctx.chunk.fileName !== entry_chunk.fileName }).map(c => c.fileName);
							if (inject_styles_file) {
								js_dependencies = js_dependencies.concat(inject_styles_file);
							}
							const css_dependencies = find_css(chunk, bundle).filter(x => !that.css_main || !that.css_main.includes(x));
							dependencies[module] = js_dependencies.concat(css_dependencies);
						}
					}
				}

				for (const chunk of js_deps(entry_chunk, { filter: ctx => ctx.dynamicImport })) {
					add_dependencies(chunk);
				}
				that.dependencies = dependencies;
			}
		};

		mod.plugins.push(css_injection);
		mod.plugins.push(sapper_internal);

		return mod;
	}

	oninvalid(cb: (filename: string) => void) {
		this._oninvalid = cb;
	}

	async compile(): Promise<CompileResult> {
		const config = await this._;
		const sourcemap = config.output.sourcemap;

		const start = Date.now();

		try {
			const bundle = await rollup.rollup(config);
			await bundle.write(config.output);
			if (bundle.getTimings != null) {
				printTimings(bundle.getTimings());
			}
			return new RollupResult(Date.now() - start, this, sourcemap);
		} catch (err) {
			// flush warnings
			stderr(new RollupResult(Date.now() - start, this, sourcemap).print());

			handleError(err);
		}
	}

	async watch(cb: (err?: Error, stats?: any) => void) {
		const config = await this._;
		const sourcemap = config.output.sourcemap;

		const watcher = rollup.watch(config);

		watcher.on('change', (id: string) => {
			this.chunks = [];
			this.warnings = [];
			this.errors = [];
			this._oninvalid(id);
		});

		watcher.on('event', (event: any) => {
			switch (event.code) {
				case 'FATAL':
					// TODO kill the process?
					if (event.error.filename) {
						// TODO this is a bit messy. Also, can
						// Rollup emit other kinds of error?
						event.error.message = [
							`Failed to build — error in ${event.error.filename}: ${event.error.message}`,
							event.error.frame
						].filter(Boolean).join('\n');
					}

					cb(event.error);
					break;

				case 'ERROR':
					this.errors.push(event.error);
					cb(null, new RollupResult(Date.now() - this._start, this, sourcemap));
					break;

				case 'START':
				case 'END':
					// TODO is there anything to do with this info?
					break;

				case 'BUNDLE_START':
					this._start = Date.now();
					break;

				case 'BUNDLE_END':
					if (event.result.getTimings != null) {
						printTimings(event.result.getTimings());
					}
					cb(null, new RollupResult(Date.now() - this._start, this, sourcemap));
					break;

				default:
					console.log(`Unexpected event ${event.code}`);
			}
		});
	}

	static async load_config(cwd: string) {
		if (!rollup) rollup = relative('rollup', cwd);

		const input = path.resolve(cwd, 'rollup.config.js');

		const bundle = await rollup.rollup({
			input,
			inlineDynamicImports: true,
			external: (id: string) => {
				return (id[0] !== '.' && !path.isAbsolute(id)) || id.slice(-5, id.length) === '.json';
			}
		});

		const {
			output: [{ code }]
		} = await bundle.generate({
			exports: 'named',
			format: 'cjs'
		});

		// temporarily override require
		const defaultLoader = require.extensions['.js'];
		require.extensions['.js'] = (module: any, filename: string) => {
			if (filename === input) {
				module._compile(code, filename);
			} else {
				defaultLoader(module, filename);
			}
		};

		const config: any = require(input).default; // eslint-disable-line
		delete require.cache[input];

		return config;
	}
}


// copied from https://github.com/rollup/rollup/blob/master/cli/logging.ts
// and updated so that it will compile here

export function handleError(err: RollupError, recover = false) {
	let description = err.message || err;
	if (err.name) description = `${err.name}: ${description}`;
	const message =
		(err.plugin
			? `(plugin ${(err).plugin}) ${description}`
			: description) || err;

	stderr(color.bold().red(`[!] ${color.bold(message.toString())}`));

	if (err.url) {
		stderr(color.cyan(err.url));
	}

	if (err.loc) {
		stderr(`${err.loc.file || err.id} (${err.loc.line}:${err.loc.column})`);
	} else if (err.id) {
		stderr(err.id);
	}

	if (err.frame) {
		stderr(color.dim(err.frame));
	}

	if (err.stack) {
		stderr(color.dim(err.stack));
	}

	stderr('');

	if (!recover) process.exit(1);
}
