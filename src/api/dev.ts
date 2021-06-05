import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as child_process from 'child_process';
import * as ports from 'port-authority';
import { EventEmitter } from 'events';
import { create_manifest_data, create_app, create_compilers, create_serviceworker_manifest } from '../core';
import { Compiler, Compilers } from '../core/create_compilers';
import { CompileResult } from '../core/create_compilers/interfaces';
import Deferred from './utils/Deferred';
import validate_bundler from './utils/validate_bundler';
import { copy_shimport } from './utils/copy_shimport';
import { ManifestData, FatalEvent, ErrorEvent, ReadyEvent, InvalidEvent } from '../interfaces';
import { noop } from './utils/noop';
import { copy_runtime } from './utils/copy_runtime';
import { rimraf, mkdirp } from './utils/fs_utils';

type Opts = {
	cwd?: string;
	src?: string;
	dest?: string;
	routes?: string;
	output?: string;
	static?: string;
	'dev-port'?: number;
	live?: boolean;
	hot?: boolean;
	'devtools-port'?: number;
	bundler?: 'rollup' | 'webpack';
	port?: number;
	ext: string;
};

export function dev(opts: Opts) {
	return new Watcher(opts);
}

class Watcher extends EventEmitter {
	bundler: 'rollup' | 'webpack';
	dirs: {
		cwd: string;
		root: string;
		src: string;
		dest: string;
		routes: string;
		output: string;
		static: string;
	}
	port: number;
	closed: boolean;

	dev_port: number;
	live: boolean;
	hot: boolean;

	devtools_port: number;

	dev_server: DevServer;
	proc: child_process.ChildProcess;
	filewatchers: Array<{ close: () => void }>;
	deferred: Deferred;

	crashed: boolean;
	restarting: boolean;
	current_build: {
		changed: Set<string>;
		rebuilding: Set<string>;
		unique_warnings: Set<string>;
		unique_errors: Set<string>;
	}
	ext: string;

	constructor({
		cwd = '.',
		src = 'src',
		routes = 'src/routes',
		output = 'src/node_modules/@sapper',
		static: static_files = 'static',
		dest = '__sapper__/dev',
		'dev-port': dev_port,
		live,
		hot,
		'devtools-port': devtools_port,
		bundler,
		port = +process.env.PORT,
		ext
	}: Opts) {
		super();

		cwd = path.resolve(cwd);

		this.bundler = validate_bundler(cwd, bundler);
		this.dirs = {
			cwd,
			root: process.cwd(),
			src: path.resolve(cwd, src),
			dest: path.resolve(cwd, dest),
			routes: path.resolve(cwd, routes),
			output: path.resolve(cwd, output),
			static: path.resolve(cwd, static_files)
		};
		this.ext = ext;
		this.port = port;
		this.closed = false;

		this.dev_port = dev_port;
		this.live = live;
		this.hot = hot;

		this.devtools_port = devtools_port;

		this.filewatchers = [];

		this.current_build = {
			changed: new Set(),
			rebuilding: new Set(),
			unique_errors: new Set(),
			unique_warnings: new Set()
		};

		process.env.NODE_ENV = 'development';

		process.on('exit', () => {
			this.close();
		});

		this.init();
	}

	async init() {
		if (this.port) {
			if (!await ports.check(this.port)) {
				this.emit('fatal', {
					message: `Port ${this.port} is unavailable`
				} as FatalEvent);
				return;
			}
		} else {
			this.port = await ports.find(3000);
		}

		const { cwd, root, src, dest, routes, output, static: static_files } = this.dirs;

		rimraf(output);
		mkdirp(output);
		copy_runtime(output);

		rimraf(dest);
		mkdirp(`${dest}/client`);
		if (this.bundler === 'rollup') copy_shimport(dest);

		if (!this.dev_port) this.dev_port = await ports.find(10000);

		// Chrome looks for debugging targets on ports 9222 and 9229 by default
		if (!this.devtools_port) this.devtools_port = await ports.find(9222);

		let manifest_data: ManifestData;

		try {
			manifest_data = create_manifest_data(routes, this.ext);
			create_app({
				bundler: this.bundler,
				manifest_data,
				dev: true,
				dev_port: this.dev_port,
				root, src, dest, routes, output
			});
		} catch (err) {
			this.emit('fatal', {
				message: err.message
			} as FatalEvent);
			return;
		}

		this.dev_server = new DevServer(this.dev_port);

		this.filewatchers.push(
			watch_dir(
				routes,
				({ path: file, stats }) => {
					if (stats.isDirectory()) {
						return path.basename(file)[0] !== '_';
					}
					return true;
				},
				() => {
					try {
						manifest_data = create_manifest_data(routes, this.ext);
						create_app({
							bundler: this.bundler,
							manifest_data,
							dev: true,
							dev_port: this.dev_port,
							root, src, dest, routes, output
						});
					} catch (error) {
						this.emit('error', {
							type: 'manifest',
							error
						} as ErrorEvent);
					}
				}
			)
		);

		if (this.live) {
			this.filewatchers.push(
				fs.watch(`${src}/template.html`, () => {
					this.dev_server.send({
						action: 'reload'
					});
				})
			);
		}

		let deferred = new Deferred();

		// TODO watch the configs themselves?
		const compilers: Compilers = await create_compilers(this.bundler, cwd, src, routes, dest, true);

		const emitFatal = () => {
			this.emit('fatal', {
				message: 'Server crashed'
			} as FatalEvent);

			this.crashed = true;
			this.proc = null;
		};

		this.watch(compilers.server, {
			name: 'server',

			invalid: filename => {
				this.restart(filename, 'server');
			},

			handle_result: (result: CompileResult) => {
				deferred.promise.then(() => {
					const restart = () => {
						this.crashed = false;

						return ports.wait(this.port)
							.then((() => {
								this.emit('ready', {
									port: this.port,
									process: this.proc
								} as ReadyEvent);

								if (this.hot && this.bundler === 'webpack') {
									this.dev_server.send({
										status: 'completed'
									});
								} else if (this.live) {
									this.dev_server.send({
										action: 'reload'
									});
								}
							}))
							.catch(err => {
								if (this.crashed) return;

								this.emit('fatal', {
									message: `Server is not listening on port ${this.port}`
								} as FatalEvent);
							});
					};

					const start_server = () => {
						// we need to give the child process its own DevTools port,
						// otherwise Node will try to use the parent's (and fail)
						const debugArgRegex = /--inspect(?:-brk|-port)?|--debug-port/;
						const execArgv = process.execArgv.slice();
						if (execArgv.some((arg: string) => !!arg.match(debugArgRegex))) {
							execArgv.push(`--inspect-port=${this.devtools_port}`);
						}

						this.proc = child_process.fork(`${dest}/server/server.js`, [], {
							cwd: process.cwd(),
							env: Object.assign({
								PORT: this.port
							}, process.env),
							stdio: ['ipc'],
							execArgv
						});

						this.proc.stdout.on('data', chunk => {
							this.emit('stdout', chunk);
						});

						this.proc.stderr.on('data', chunk => {
							this.emit('stderr', chunk);
						});

						this.proc.on('message', message => {
							if (message.__sapper__ && message.event === 'basepath') {
								this.emit('basepath', {
									basepath: message.basepath
								});
							}
						});

						this.proc.on('exit', emitFatal);
					};

					if (this.proc) {
						if (this.restarting) return;
						this.restarting = true;
						this.proc.removeListener('exit', emitFatal);
						this.proc.kill();
						this.proc.on('exit', async () => {
							start_server();
							await restart();
							this.restarting = false;
						});
					} else {
						start_server();
						restart();
					}
				});
			}
		});

		this.watch(compilers.client, {
			name: 'client',

			invalid: filename => {
				this.restart(filename, 'client');
				deferred = new Deferred();

				// TODO we should delete old assets. due to a webpack bug
				// i don't even begin to comprehend, this is apparently
				// quite difficult
			},

			handle_result: (result: CompileResult) => {
				fs.writeFileSync(
					path.join(dest, 'build.json'),
					JSON.stringify(result.to_json(manifest_data, this.dirs), null, '  ')
				);

				const client_files = result.chunks.map(chunk => `client/${chunk.file}`);

				create_serviceworker_manifest({
					manifest_data,
					output,
					client_files,
					static_files
				});

				deferred.fulfil();

				// we need to wait a beat before watching the service
				// worker, because of some webpack nonsense
				setTimeout(watch_serviceworker, 100);
			}
		});

		let watch_serviceworker = compilers.serviceworker
			? () => {
				watch_serviceworker = noop;

				this.watch(compilers.serviceworker, {
					name: 'service worker'
				});
			}
			: noop;
	}

	close() {
		if (this.closed) return;
		this.closed = true;

		if (this.dev_server) this.dev_server.close();

		if (this.proc) this.proc.kill();
		this.filewatchers.forEach(watcher => {
			watcher.close();
		});
	}

	restart(filename: string, type: string) {
		if (this.restarting) {
			this.current_build.changed.add(filename);
			this.current_build.rebuilding.add(type);
		} else {
			this.restarting = true;

			this.current_build = {
				changed: new Set([filename]),
				rebuilding: new Set([type]),
				unique_warnings: new Set(),
				unique_errors: new Set()
			};

			process.nextTick(() => {
				this.emit('invalid', {
					changed: Array.from(this.current_build.changed),
					invalid: {
						server: this.current_build.rebuilding.has('server'),
						client: this.current_build.rebuilding.has('client'),
						serviceworker: this.current_build.rebuilding.has('serviceworker')
					}
				} as InvalidEvent);

				this.restarting = false;
			});
		}
	}

	watch(compiler: Compiler, { name, invalid = noop, handle_result = noop }: {
		name: string;
		invalid?: (filename: string) => void;
		handle_result?: (result: CompileResult) => void;
	}) {
		compiler.oninvalid(invalid);

		compiler.watch((error?: Error, result?: CompileResult) => {
			if (error) {
				this.emit('error', {
					type: name,
					error
				} as ErrorEvent);
			} else {
				this.emit('build', {
					type: name,

					duration: result.duration,
					errors: result.errors,
					warnings: result.warnings
				});

				handle_result(result);
			}
		});
	}
}

const INTERVAL = 10000;

class DevServer {
	clients: Set<http.ServerResponse>;
	interval: NodeJS.Timer;
	_: http.Server;

	constructor(port: number, interval = 10000) {
		this.clients = new Set();

		this._ = http.createServer((req, res) => {
			if (req.url !== '/__sapper__') return;

			req.socket.setKeepAlive(true);
			res.writeHead(200, {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Headers': 'Cache-Control',
				'Content-Type': 'text/event-stream;charset=utf-8',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				// While behind nginx, event stream should not be buffered:
				// http://nginx.org/docs/http/ngx_http_proxy_module.html#proxy_buffering
				'X-Accel-Buffering': 'no'
			});

			res.write('\n');

			this.clients.add(res);
			req.on('close', () => {
				this.clients.delete(res);
			});
		});

		this._.listen(port);

		this.interval = setInterval(() => {
			this.send(null);
		}, INTERVAL);
	}

	close() {
		this._.close();
		clearInterval(this.interval);
	}

	send(data: any) {
		this.clients.forEach(client => {
			client.write(`data: ${JSON.stringify(data)}\n\n`);
		});
	}
}

function watch_dir(
	dir: string,
	filter: ({ path, stats }: { path: string; stats: fs.Stats }) => boolean,
	callback: () => void
) {
	let watch: any;
	let closed = false;

	import('cheap-watch').then(({ default: CheapWatch }) => {
		if (closed) return;

		watch = new CheapWatch({ dir, filter, debounce: 50 });

		watch.on('+', callback);

		watch.on('-', callback);

		watch.init();
	});

	return {
		close: () => {
			if (watch) watch.close();
			closed = true;
		}
	};
}
