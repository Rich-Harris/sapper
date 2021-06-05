import * as fs from 'fs';
import * as path from 'path';

export default function validate_bundler(cwd: string, bundler?: 'rollup' | 'webpack') {
	if (!bundler) {
		bundler = (
			fs.existsSync(path.resolve(cwd, 'rollup.config.js')) || fs.existsSync(path.resolve(cwd, 'rollup.config.ts')) ? 'rollup' :
				fs.existsSync(path.resolve(cwd, 'webpack.config.js')) || fs.existsSync(path.resolve(cwd, 'webpack.config.ts')) ? 'webpack' : null
		);

		if (!bundler) {
			// TODO remove in a future version
			deprecate_dir(cwd, 'rollup');
			deprecate_dir(cwd, 'webpack');

			throw new Error('Could not find a configuration file for rollup or webpack');
		}
	}

	if (bundler !== 'rollup' && bundler !== 'webpack') {
		throw new Error(`'${bundler}' is not a valid option for --bundler — must be either 'rollup' or 'webpack'`);
	}

	return bundler;
}

function deprecate_dir(cwd: string, bundler: 'rollup' | 'webpack') {
	try {
		const stats = fs.statSync(path.resolve(cwd, bundler));
		if (!stats.isDirectory()) return;
	} catch (err) {
		// do nothing
		return;
	}

	// TODO link to docs, once those docs exist
	throw new Error(`As of Sapper 0.21, build configuration should be placed in a single ${bundler}.config.js file`);
}
