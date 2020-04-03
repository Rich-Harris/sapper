import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import fetch from 'node-fetch';
import * as yootils from 'yootils';
import * as ports from 'port-authority';
import clean_html from './utils/clean_html';
import minify_html from './utils/minify_html';
import Deferred from './utils/Deferred';
import { noop } from './utils/noop';
import { parse as parseLinkHeader } from 'http-link-header';
import { rimraf, copy, mkdirp } from './utils/fs_utils';

type Opts = {
	build_dir?: string,
	export_dir?: string,
	cwd?: string,
	static?: string,
	basepath?: string,
	host_header?: string,
	timeout?: number | false,
	concurrent?: number,
	oninfo?: ({ message }: { message: string }) => void;
	onfile?: ({ file, size, status }: { file: string, size: number, status: number }) => void;
	entry?: string;
};

type Ref = {
	uri: string,
	rel: string,
	as: string
};

function resolve(from: string, to: string) {
	return url.parse(url.resolve(from, to));
}

function cleanPath(path: string) {
	return path.replace(/^\/|\/$|\/*index(.html)*$|.html$/g, '')
}

type URL = url.UrlWithStringQuery;

export { _export as export };

async function _export({
	cwd,
	static: static_files = 'static',
	build_dir = '__sapper__/build',
	export_dir = '__sapper__/export',
	basepath = '',
	host_header,
	timeout = 5000,
	concurrent = 8,
	oninfo = noop,
	onfile = noop,
	entry = '/'
}: Opts = {}) {
	basepath = basepath.replace(/^\//, '')

	cwd = path.resolve(cwd);
	static_files = path.resolve(cwd, static_files);
	build_dir = path.resolve(cwd, build_dir);
	export_dir = path.resolve(cwd, export_dir, basepath);

	// Prep output directory
	rimraf(export_dir);

	const seen: Set<string> = new Set();
	copy(static_files, export_dir)
		.forEach((element:string) => seen.add(element.replace(static_files + "/", "")));

	copy(path.join(build_dir, 'client'), path.join(export_dir, 'client'));
	copy(path.join(build_dir, 'service-worker.js'), path.join(export_dir, 'service-worker.js'));
	copy(path.join(build_dir, 'service-worker.js.map'), path.join(export_dir, 'service-worker.js.map'));

	const defaultPort = process.env.PORT ? parseInt(process.env.PORT) : 3000;
	const port = await ports.find(defaultPort);

	const protocol = 'http:';
	const host = `localhost:${port}`;
	const origin = `${protocol}//${host}`;

	const root = resolve(origin, basepath);
	if (!root.href.endsWith('/')) root.href += '/';

	const entryPoints = entry.split(' ').map(entryPoint => {
		const entry = resolve(origin, `${basepath}/${cleanPath(entryPoint)}`);
		if (!entry.href.endsWith('/')) entry.href += '/';

		return entry;
	});

	const proc = child_process.fork(path.resolve(`${build_dir}/server/server.js`), [], {
		cwd,
		env: Object.assign({
			PORT: port,
			NODE_ENV: 'production',
			SAPPER_EXPORT: 'true'
		}, process.env)
	});

	const saved = new Set();
	const q = yootils.queue(concurrent);

	function save(url: string, status: number, type: string, body: string) {
		const { pathname } = resolve(origin, url);
		let file = decodeURIComponent(pathname.slice(1));

		if (saved.has(file)) return;
		saved.add(file);

		const is_html = type === 'text/html';

		if (is_html) {
			if (pathname !== '/service-worker-index.html') {
				file = file === '' ? 'index.html' : `${file}/index.html`;
			}
			body = minify_html(body);
		}

		onfile({
			file,
			size: body.length,
			status
		});

		const export_file = path.join(export_dir, file);
		if (fs.existsSync(export_file)) return;
		mkdirp(path.dirname(export_file));
		fs.writeFileSync(export_file, body);
	}

	proc.on('message', message => {
		if (!message.__sapper__ || message.event !== 'file') return;
		save(message.url, message.status, message.type, message.body);
	});

	async function handle(url: URL) {
		let pathname = url.pathname;
		if (pathname !== '/service-worker-index.html') {
			pathname = pathname.replace(root.pathname, '') || '/'
		}

		if (seen.has(pathname)) return;
		seen.add(pathname);

		const r = await q.add(async () => {
			const timeout_deferred = new Deferred();
			const the_timeout = setTimeout(() => {
				timeout_deferred.reject(new Error(`Timed out waiting for ${url.href}`));
			}, timeout);

			const r = await Promise.race([
				fetch(url.href, {
					headers: { host: host_header || host },
					redirect: 'manual'
				}),
				timeout_deferred.promise
			]);

			clearTimeout(the_timeout); // prevent it hanging at the end

			return r;
		}) as Response;

		let type = r.headers.get('Content-Type');

		let body = await r.text();

		const range = ~~(r.status / 100);

		let tasks = [];

		if (range === 2) {
			if (type === 'text/html') {
				// parse link rel=preload headers and embed them in the HTML
				let link = parseLinkHeader(r.headers.get('Link') || '');
				link.refs.forEach((ref: Ref) => {
					if (ref.rel === 'preload') {
						body = body.replace('</head>',
							`<link rel="preload" as=${JSON.stringify(ref.as)} href=${JSON.stringify(ref.uri)}></head>`)
					}
				});

				if (pathname !== '/service-worker-index.html') {
					const cleaned = clean_html(body);

					const base_match = /<base ([\s\S]+?)>/m.exec(cleaned);
					const base_href = base_match && get_href(base_match[1]);
					const base = resolve(url.href, base_href);

					let match;
					let pattern = /<a ([\s\S]+?)>/gm;

					while (match = pattern.exec(cleaned)) {
						const attrs = match[1];
						const href = get_href(attrs);

						if (href) {
							const url = resolve(base.href, href);

							if (url.protocol === protocol && url.host === host) {
								tasks.push(handle(url));
							}
						}
					}
				}
			}
		}

		if (range === 3) {
			const location = r.headers.get('Location');

			type = 'text/html';
			body = `<script>window.location.href = "${location.replace(origin, '')}"</script>`;

			tasks.push(handle(resolve(root.href, location)));
		}

		save(pathname, r.status, type, body);

		await Promise.all(tasks);
	}

	try {
		await ports.wait(port);

		for (const entryPoint of entryPoints) {
			oninfo({
				message: `Crawling ${entryPoint.href}`
			});
			await handle(entryPoint);
		}

		await handle(resolve(root.href, 'service-worker-index.html'));
		await q.close();

		proc.kill()
	} catch (err) {
		proc.kill();
		throw err;
	}
}

function get_href(attrs: string) {
	const match = /href\s*=\s*(?:"(.*?)"|'(.*?)'|([^\s>]*))/.exec(attrs);
	return match && (match[1] || match[2] || match[3]);
}
