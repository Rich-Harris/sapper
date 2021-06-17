import fs from 'fs';
import path from 'path';
import mime from 'mime/lite';
import { Handler, SapperRequest, SapperResponse, build_dir, dev, manifest } from '@sapper/internal/manifest-server';
import { get_server_route_handler } from './get_server_route_handler';
import { get_page_handler } from './get_page_handler';

type IgnoreValue = IgnoreValue[] | RegExp | ((uri: string) => boolean) | string;

export default function middleware(opts: {
	session?: (req: SapperRequest, res: SapperResponse) => any,
	ignore?: IgnoreValue
} = {}) {
	const { session, ignore } = opts;

	let emitted_basepath = false;

	return compose_handlers(ignore, [
		(req: SapperRequest, res: SapperResponse, next: () => void) => {
			if (req.baseUrl === undefined) {
				let originalUrl = req.originalUrl || req.url;
				if (req.url === '/' && originalUrl[originalUrl.length - 1] !== '/') {
					originalUrl += '/';
				}

				req.baseUrl = originalUrl
					? decodeURI(originalUrl).slice(0, -req.url.length)
					: '';
			}

			if (!emitted_basepath && process.send) {
				process.send({
					__sapper__: true,
					event: 'basepath',
					basepath: req.baseUrl
				});

				emitted_basepath = true;
			}

			if (req.path === undefined) {
				req.path = req.url.replace(/\?.*/, '');
			}

			next();
		},

		fs.existsSync(path.join(build_dir, 'service-worker.js')) && serve({
			pathname: '/service-worker.js',
			cache_control: 'no-cache, no-store, must-revalidate'
		}),

		fs.existsSync(path.join(build_dir, 'service-worker.js.map')) && serve({
			pathname: '/service-worker.js.map',
			cache_control: 'no-cache, no-store, must-revalidate'
		}),

		serve({
			prefix: '/client/',
			cache_control: dev ? 'no-cache' : 'max-age=31536000, immutable'
		}),

		get_server_route_handler(manifest.server_routes),

		get_page_handler(manifest, session || noop)
	].filter(Boolean));
}

export function compose_handlers(ignore: IgnoreValue, handlers: Handler[]): Handler {
	const total = handlers.length;

	function nth_handler(n: number, req: SapperRequest, res: SapperResponse, next: () => void) {
		if (n >= total) {
			return next();
		}

		handlers[n](req, res, () => nth_handler(n+1, req, res, next));
	}

	return !ignore
		? (req, res, next) => nth_handler(0, req, res, next)
		: (req, res, next) => {
			if (should_ignore(req.path, ignore)) {
				next();
			} else {
				nth_handler(0, req, res, next);
			}
		};
}

export function should_ignore(uri: string, val: IgnoreValue) {
	if (Array.isArray(val)) return val.some(x => should_ignore(uri, x));
	if (val instanceof RegExp) return val.test(uri);
	if (typeof val === 'function') return val(uri);
	return uri.startsWith(val.charCodeAt(0) === 47 ? val : `/${val}`);
}

export function serve({ prefix, pathname, cache_control }: {
	prefix?: string,
	pathname?: string,
	cache_control: string
}) {
	const filter = pathname
		? (req: SapperRequest) => req.path === pathname
		: (req: SapperRequest) => req.path.startsWith(prefix);

	const cache: Map<string, Buffer> = new Map();

	const read = dev
		? (file: string) => fs.readFileSync(path.join(build_dir, file))
		: (file: string) => (cache.has(file) ? cache : cache.set(file, fs.readFileSync(path.join(build_dir, file)))).get(file);

	return (req: SapperRequest, res: SapperResponse, next: () => void) => {
		if (filter(req)) {
			const type = mime.getType(req.path);

			try {
				const file = path.posix.normalize(decodeURIComponent(req.path));
				const data = read(file);

				res.setHeader('Content-Type', type);
				res.setHeader('Cache-Control', cache_control);
				res.end(data);
			} catch (err) {
				if (err.code === 'ENOENT') {
					next();
				} else if (err.code === 'EISDIR') {
					res.statusCode = 404;
					res.end('Not Found');
				} else {
					console.error(err);

					res.statusCode = 500;
					res.end('an error occurred while reading a static file from disk');
				}
			}
		} else {
			next();
		}
	};
}

async function noop() {}
