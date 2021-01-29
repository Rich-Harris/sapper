import { writable } from 'svelte/store';
import fs from 'fs';
import path from 'path';
import { parse } from 'cookie';
import devalue from 'devalue';
import fetch from 'node-fetch';
import URL from 'url';
import { sourcemap_stacktrace } from './sourcemap_stacktrace';
import {
    Manifest,
    ManifestPage,
    SapperRequest,
    SapperResponse,
    build_dir,
    dev,
    src_dir
} from '@sapper/internal/manifest-server';
import App from '@sapper/internal/App.svelte';
import { PageContext, PreloadResult } from '@sapper/common';
import detectClientOnlyReferences from './detect_client_only_references';

export function get_page_handler(
	manifest: Manifest,
	session_getter: (req: SapperRequest, res: SapperResponse) => Promise<any>
) {
	const get_build_info = dev
		? () => JSON.parse(fs.readFileSync(path.join(build_dir, 'build.json'), 'utf-8'))
		: (assets => () => assets)(JSON.parse(fs.readFileSync(path.join(build_dir, 'build.json'), 'utf-8')));

	const template = dev
		? () => read_template(src_dir)
		: (str => () => str)(read_template(build_dir));

	const has_service_worker = fs.existsSync(path.join(build_dir, 'service-worker.js'));

	const { pages, error: error_route } = manifest;

	function bail(res: SapperResponse, err: Error | string) {
		console.error(err);

		const message = dev ? escape_html(typeof err === 'string' ? err : err.message) : 'Internal server error';

		res.statusCode = 500;
		res.end(`<pre>${message}</pre>`);
	}

	function handle_error(req: SapperRequest, res: SapperResponse, statusCode: number, error: Error | string) {
		handle_page({
			pattern: null,
			parts: [
				{ name: null, component: { default: error_route } }
			]
		}, req, res, statusCode, error || 'Unknown error');
	}

	async function handle_page(
        page: ManifestPage,
        req: SapperRequest,
        res: SapperResponse,
        status = 200,
        error: Error | string = null) {
		const is_service_worker_index = req.path === '/service-worker-index.html';
		const build_info: {
			bundler: 'rollup' | 'webpack',
			shimport: string | null,
			assets: Record<string, string | string[]>,
			dependencies: Record<string, string[]>,
			css?: { main: string[] },
			legacy_assets?: Record<string, string>
		} = get_build_info();

		res.setHeader('Content-Type', 'text/html');

		// preload main js and css
		// TODO detect other stuff we can preload like fonts?
		let preload_files = Array.isArray(build_info.assets.main) ? build_info.assets.main : [build_info.assets.main];
		if (build_info?.css?.main) {
			preload_files = preload_files.concat(build_info?.css?.main);
		}

		let es6_preload = false;
		if (build_info.bundler === 'rollup') {
			es6_preload = true;
			const route = page.parts[page.parts.length - 1].file;
			const deps = build_info.dependencies[route];
			if (deps) {
				preload_files = preload_files.concat(deps);
			}
		} else if (!error && !is_service_worker_index) {
			page.parts.forEach(part => {
				if (!part) return;
				// using concat because it could be a string or an array. thanks webpack!
				preload_files = preload_files.concat(build_info.assets[part.name]);
			});
		}

		const link = preload_files
			.filter((v, i, a) => a.indexOf(v) === i)        // remove any duplicates
			.filter(file => file && !file.match(/\.map$/))  // exclude source maps
			.map((file) => {
				const as = /\.css$/.test(file) ? 'style' : 'script';
				const rel = es6_preload && as === 'script' ? 'modulepreload' : 'preload';
				return `<${req.baseUrl}/client/${file}>;rel="${rel}";as="${as}"`;
			})
			.join(', ');

		res.setHeader('Link', link);

		let session;
		try {
			session = await session_getter(req, res);
		} catch (err) {
			return bail(res, err);
		}

		let redirect: { statusCode: number, location: string };
		let preload_error: { statusCode: number, message: Error | string };

		const preload_context = {
			redirect: (statusCode: number, location: string) => {
				if (redirect && (redirect.statusCode !== statusCode || redirect.location !== location)) {
					throw new Error('Conflicting redirects');
				}
				location = location.replace(/^\//g, ''); // leading slash (only)
				redirect = { statusCode, location };
			},
			error: (statusCode: number, message: Error | string) => {
				preload_error = { statusCode, message };
			},
			fetch: async (url: string, opts?: any) => {
				const protocol = req.socket.encrypted ? 'https' : 'http';
				const parsed = new URL.URL(url, `${protocol}://127.0.0.1:${process.env.PORT}${req.baseUrl ? req.baseUrl + '/' :''}`);

				opts = Object.assign({}, opts);

				const include_credentials = (
					opts.credentials === 'include' ||
					opts.credentials !== 'omit' && parsed.origin === `${protocol}://127.0.0.1:${process.env.PORT}`
				);

				if (include_credentials) {
					opts.headers = Object.assign({}, opts.headers);

					const cookies = Object.assign(
						{},
						parse(req.headers.cookie || ''),
						parse(opts.headers.cookie || '')
					);

					const set_cookie = res.getHeader('Set-Cookie');
					(Array.isArray(set_cookie) ? set_cookie : [set_cookie]).forEach((s: string) => {
						const m = /([^=]+)=([^;]+)/.exec(s);
						if (m) cookies[m[1]] = m[2];
					});

					const str = Object.keys(cookies)
						.map(key => `${key}=${cookies[key]}`)
						.join('; ');

					opts.headers.cookie = str;

					if (!opts.headers.authorization && req.headers.authorization) {
						opts.headers.authorization = req.headers.authorization;
					}
				}

				const response = await fetch(parsed.href, opts);

				const header = response.headers.get('Set-Cookie');

				if (header !== null) {
					res.setHeader('Set-Cookie', header);
				}

				return response;
			}
		};

		let preloaded: object[];
		let match: RegExpExecArray;
		let params: Record<string,string>;

		try {
			const root_preload = manifest.root_comp.preload || (() => {});
			const root_preloaded: PreloadResult = detectClientOnlyReferences(() =>
				root_preload.call(
					preload_context,
					{
						host: req.headers.host,
						path: req.path,
						query: req.query,
						params: {}
					},
					session
				)
			);

			match = error ? null : page.pattern.exec(req.path);

			let toPreload: PreloadResult[] = [root_preloaded];
			if (!is_service_worker_index) {
				toPreload = toPreload.concat(page.parts.map(part => {
					if (!part) return null;

					// the deepest level is used below, to initialise the store
					params = part.params ? part.params(match) : {};

					return part.component.preload
						? detectClientOnlyReferences(() =>
								part.component.preload.call(
									preload_context,
									{
										host: req.headers.host,
										path: req.path,
										query: req.query,
										params
									},
									session
								)
						  )
						: {};
				}));
			}

			preloaded = await Promise.all(toPreload);
		} catch (err) {
			if (error) {
				return bail(res, err);
			}

			preload_error = { statusCode: 500, message: err };
			preloaded = []; // appease TypeScript
		}

		try {
			if (redirect) {
				const location = URL.resolve((req.baseUrl || '') + '/', redirect.location);

				res.statusCode = redirect.statusCode;
				res.setHeader('Location', location);
				res.end();

				return;
			}

			if (preload_error) {
				if (!error) {
					handle_error(req, res, preload_error.statusCode, preload_error.message);
				} else {
					bail(res, preload_error.message);
				}

				return;
			}

			const segments = req.path.split('/').filter(Boolean);

			// TODO make this less confusing
			const layout_segments = [segments[0]];
			let l = 1;

			page.parts.forEach((part, i) => {
				layout_segments[l] = segments[i + 1];
				if (!part) return null;
				l++;
			});

			if (error instanceof Error && error.stack) {
				error.stack = sourcemap_stacktrace(error.stack);
			}

			const pageContext: PageContext = {
				host: req.headers.host,
				path: req.path,
				query: req.query,
				params,
				error: error
					? error instanceof Error
						? error
						: { message: error, name: 'PreloadError' }
					: null
			};

			const props = {
				stores: {
					page: {
						subscribe: writable(pageContext).subscribe
					},
					preloading: {
						subscribe: writable(null).subscribe
					},
					session: writable(session)
				},
				segments: layout_segments,
				status: error ? status : 200,
				error: pageContext.error,
				level0: {
					props: preloaded[0]
				},
				level1: {
					segment: segments[0],
					props: {}
				}
			};

			if (!is_service_worker_index) {
				let level_index = 1;
				for (let i = 0; i < page.parts.length; i += 1) {
					const part = page.parts[i];
					if (!part) continue;

					props[`level${level_index++}`] = {
						component: part.component.default,
						props: preloaded[i + 1] || {},
						segment: segments[i]
					};
				}
			}

			const { html, head, css } = detectClientOnlyReferences(() => App.render(props));

			const serialized = {
				preloaded: `[${preloaded.map(data => try_serialize(data, err => {
					console.error(`Failed to serialize preloaded data to transmit to the client at the /${segments.join('/')} route: ${err.message}`);
					console.warn('The client will re-render over the server-rendered page fresh instead of continuing where it left off. See https://sapper.svelte.dev/docs#Return_value for more information');
				})).join(',')}]`,
				session: session && try_serialize(session, err => {
					throw new Error(`Failed to serialize session data: ${err.message}`);
				}),
				error: error && serialize_error(props.error)
			};

			let script = `__SAPPER__={${[
				error && `error:${serialized.error},status:${status}`,
				`baseUrl:"${req.baseUrl}"`,
				serialized.preloaded && `preloaded:${serialized.preloaded}`,
				serialized.session && `session:${serialized.session}`
			].filter(Boolean).join(',')}};`;

			if (has_service_worker) {
				script += `if('serviceWorker' in navigator)navigator.serviceWorker.register('${req.baseUrl}/service-worker.js');`;
			}

			const file = [].concat(build_info.assets.main).filter(f => f && /\.js$/.test(f))[0];
			const main = `${req.baseUrl}/client/${file}`;

			// users can set a CSP nonce using res.locals.nonce
			const nonce_value = (res.locals && res.locals.nonce) ? res.locals.nonce : '';
			const nonce_attr = nonce_value ? ` nonce="${nonce_value}"` : '';

			if (build_info.bundler === 'rollup') {
				if (build_info.legacy_assets) {
					const legacy_main = `${req.baseUrl}/client/legacy/${build_info.legacy_assets.main}`;
					script += `(function(){try{eval("async function x(){}");var main="${main}"}catch(e){main="${legacy_main}"};var s=document.createElement("script");try{new Function("if(0)import('')")();s.src=main;s.type="module";s.crossOrigin="use-credentials";}catch(e){s.src="${req.baseUrl}/client/shimport@${build_info.shimport}.js";s.setAttribute("data-main",main);}document.head.appendChild(s);}());`;
				} else {
					script += `var s=document.createElement("script");try{new Function("if(0)import('')")();s.src="${main}";s.type="module";s.crossOrigin="use-credentials";}catch(e){s.src="${req.baseUrl}/client/shimport@${build_info.shimport}.js";s.setAttribute("data-main","${main}")}document.head.appendChild(s)`;
				}
			} else {
				script += `</script><script${nonce_attr} src="${main}" defer>`;
			}

			let styles: string;

			// TODO make this consistent across apps
			// TODO embed build_info in placeholder.ts
			if (build_info.css && build_info.css.main) {
				const css_chunks = new Set(build_info.css.main);
				page.parts.forEach(part => {
					if (!part || !build_info.dependencies) return;
					const deps_for_part = build_info.dependencies[part.file];

					if (deps_for_part) {
						deps_for_part.filter(d => d.endsWith('.css')).forEach(chunk => {
							css_chunks.add(chunk);
						});
					}
				});

				styles = Array.from(css_chunks)
					.map(href => `<link rel="stylesheet" href="client/${href}">`)
					.join('');
			} else {
				styles = (css && css.code ? `<style${nonce_attr}>${css.code}</style>` : '');
			}

			const body = template()
				.replace('%sapper.base%', () => `<base href="${req.baseUrl}/">`)
				.replace('%sapper.scripts%', () => `<script${nonce_attr}>${script}</script>`)
				.replace('%sapper.html%', () => html)
				.replace('%sapper.head%', () => head)
				.replace('%sapper.styles%', () => styles)
				.replace(/%sapper\.cspnonce%/g, () => nonce_value);

			res.statusCode = status;
			res.end(body);
		} catch (err) {
			if (error) {
				bail(res, err);
			} else {
				handle_error(req, res, 500, err);
			}
		}
	}

	return function find_route(req: SapperRequest, res: SapperResponse, next: () => void) {
		const req_path = req.path === '/service-worker-index.html' ? '/' : req.path;

		const page = pages.find(p => p.pattern.test(req_path));

		if (page) {
			handle_page(page, req, res);
		} else {
			handle_error(req, res, 404, 'Not found');
		}
	};
}

function read_template(dir = build_dir) {
	return fs.readFileSync(`${dir}/template.html`, 'utf-8');
}

function try_serialize(data: any, fail?: (err: Error) => void) {
	try {
		return devalue(data);
	} catch (err) {
		if (fail) fail(err);
		return null;
	}
}

// Ensure we return something truthy so the client will not re-render the page over the error
function serialize_error(error: Error) {
	if (!error) return null;
	let serialized = try_serialize(error);
	if (!serialized) {
		const { name, message, stack } = error as Error;
		serialized = try_serialize({ name, message, stack });
	}
	if (!serialized) {
		serialized = '{}';
	}
	return serialized;
}

function escape_html(html: string) {
	const chars: Record<string, string> = {
		'"' : 'quot',
		'\'': '#39',
		'&': 'amp',
		'<' : 'lt',
		'>' : 'gt'
	};

	return html.replace(/["'&<>]/g, c => `&${chars[c]};`);
}
