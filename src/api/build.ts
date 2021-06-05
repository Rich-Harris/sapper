import * as fs from 'fs';
import * as path from 'path';
import minify_html from './utils/minify_html';
import { create_compilers, create_app, create_manifest_data, create_serviceworker_manifest } from '../core';
import { copy_shimport } from './utils/copy_shimport';
import read_template from '../core/read_template';
import { CompileResult } from '../core/create_compilers/interfaces';
import { noop } from './utils/noop';
import validate_bundler from './utils/validate_bundler';
import { copy_runtime } from './utils/copy_runtime';
import { rimraf, mkdirp } from './utils/fs_utils';

type Opts = {
	cwd?: string;
	root?: string;
	src?: string;
	routes?: string;
	dest?: string;
	output?: string;
	static?: string;
	legacy?: boolean;
	bundler?: 'rollup' | 'webpack';
	ext?: string;
	oncompile?: ({ type, result }: { type: string; result: CompileResult }) => void;
};

export async function build({
	cwd,
	root = undefined,
	src = 'src',
	routes = 'src/routes',
	output = 'src/node_modules/@sapper',
	static: static_files = 'static',
	dest = '__sapper__/build',

	bundler = undefined,
	legacy = false,
	ext = undefined,
	oncompile = noop
}: Opts = {}) {

	cwd = path.resolve(cwd);
	root = root ? path.resolve(root) : cwd;
	src = path.resolve(cwd, src);
	dest = path.resolve(cwd, dest);
	routes = path.resolve(cwd, routes);
	output = path.resolve(cwd, output);
	static_files = path.resolve(cwd, static_files);

	bundler = validate_bundler(cwd, bundler);

	if (legacy && bundler === 'webpack') {
		throw new Error('Legacy builds are not supported for projects using webpack');
	}

	rimraf(output);
	mkdirp(output);
	copy_runtime(output);

	rimraf(dest);
	mkdirp(`${dest}/client`);
	copy_shimport(dest);

	// minify src/template.html
	// TODO compile this to a function? could be quicker than str.replace(...).replace(...).replace(...)
	const template = read_template(src);

	fs.writeFileSync(`${dest}/template.html`, minify_html(template));

	const manifest_data = create_manifest_data(routes, ext);

	// create src/node_modules/@sapper/app.mjs and server.mjs
	create_app({
		bundler,
		manifest_data,
		root,
		src,
		dest,
		routes,
		output,
		dev: false
	});

	const { client, server, serviceworker } = await create_compilers(bundler, cwd, src, routes, dest, false);

	const client_result = await client.compile();
	oncompile({
		type: 'client',
		result: client_result
	});

	const build_info = client_result.to_json(manifest_data, { src, routes, dest });

	if (legacy) {
		process.env.SAPPER_LEGACY_BUILD = 'true';
		const { client: legacy_client } = await create_compilers(bundler, cwd, src, routes, dest, false);

		const legacy_client_result = await legacy_client.compile();

		oncompile({
			type: 'client (legacy)',
			result: legacy_client_result
		});

		legacy_client_result.to_json(manifest_data, { src, routes, dest });
		build_info.legacy_assets = legacy_client_result.assets;
		delete process.env.SAPPER_LEGACY_BUILD;
	}
	fs.writeFileSync(path.join(dest, 'build.json'), JSON.stringify(build_info, null, '  '));

	const server_stats = await server.compile();
	oncompile({
		type: 'server',
		result: server_stats
	});

	let serviceworker_stats;

	if (serviceworker) {

		const client_files = client_result.chunks
			.filter(chunk => !chunk.file.endsWith('.map')) // SW does not need to cache sourcemap files
			.map(chunk => `client/${chunk.file}`);

		create_serviceworker_manifest({
			manifest_data,
			output,
			client_files,
			static_files
		});

		serviceworker_stats = await serviceworker.compile();

		oncompile({
			type: 'serviceworker',
			result: serviceworker_stats
		});
	}
}
