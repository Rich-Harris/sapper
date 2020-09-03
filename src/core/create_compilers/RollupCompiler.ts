import * as path from 'path';
import color from 'kleur';
import relative from 'require-relative';
import { dependenciesForTree, DependencyTreeOptions } from 'rollup-dependency-tree';
import {
	PluginContext,
	NormalizedInputOptions,
	NormalizedOutputOptions,
	RenderedChunk,
	RollupError,
	OutputBundle,
	OutputChunk
} from 'rollup';
import { CompileResult } from './interfaces';
import RollupResult from './RollupResult';

const stderr = console.error.bind(console);

let rollup: any;

const get_entry_point_output_chunk = (bundle: OutputBundle, entry_point?: string) => {
	if (entry_point === undefined) {
		throw new Error("Internal error: entry_point cannot be undefined");
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
		let entry_point: string | undefined;

		const that = this;

		// TODO this is hacky, and doesn't need to apply to all three compilers
		(mod.plugins || (mod.plugins = [])).push({
			name: 'sapper-internal',
			buildStart(this: PluginContext, options: NormalizedInputOptions): void {
				const input = options.input;
				const inputs: Array<{alias: string, file: string}> = [];

				if (typeof input === 'string') {
					inputs.push({alias: 'main', file: input});
				} else if (Array.isArray(input)) {
					inputs.push(...input.map(file => ({file, alias: file})));
				} else {
					for (const alias in input) {
						inputs.push({file: input[alias], alias});
					}
				}
				if (!entry_point) {
					entry_point = inputs[0].file;
				}
			},
			renderChunk(code: string, chunk: RenderedChunk) {	
				that.chunks.push(chunk);
			},
			async generateBundle(this: PluginContext, options: NormalizedOutputOptions, bundle: OutputBundle): Promise<void> {

				function js_deps(chunk: RenderedChunk, opts?: DependencyTreeOptions) {
					return Array.from(dependenciesForTree(chunk, that.chunks, opts));
				}

				function is_route(file_path: string) {
					return file_path.includes(that.routes) && !file_path.includes(path.sep + '_');
				}

				function get_route_entry_chunks(main_entry_chunk: RenderedChunk) {
					return js_deps(main_entry_chunk, { filter: ctx => ctx.dynamicImport
						&& ctx.chunk.facadeModuleId && is_route(ctx.chunk.facadeModuleId) });
				}

				// Store the build dependencies so that we can create build.json
				const dependencies = {};

				// We need to handle the entry point separately
				// If there's a single page and preserveEntrySignatures is false then Rollup will
				// put everything in the entry point chunk (client.hash.js)
				// In that case we can't look it up by route, but still want to include it
				const entry_chunk = get_entry_point_output_chunk(bundle, entry_point);
				const route_entry_chunks = get_route_entry_chunks(entry_chunk);
				that.js_main = entry_chunk.fileName;

				// Routes dependencies
				for (const chunk of route_entry_chunks) {
					const js_dependencies = js_deps(chunk, { walk: ctx => !ctx.dynamicImport && ctx.chunk.fileName !== entry_chunk.fileName }).map(c => c.fileName);
					dependencies[chunk.facadeModuleId] = [...js_dependencies];
				}
				that.dependencies = dependencies;
			}
		});

		const onwarn = mod.onwarn || ((warning: any, handler: (warning: any) => void) => {
			handler(warning);
		});

		mod.onwarn = (warning: any) => {
			onwarn(warning, (warn: any) => {
				this.warnings.push(warn);
			});
		};

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
