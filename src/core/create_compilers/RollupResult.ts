import * as path from 'path';
import colors from 'kleur';
import pb from 'pretty-bytes';
import RollupCompiler from './RollupCompiler';
import { left_pad } from '../../utils';
import { CompileResult } from './interfaces';

function munge_warning_or_error(warning_or_error: any) {
	return {
		file: warning_or_error.filename,
		message: [warning_or_error.message, warning_or_error.frame].filter(Boolean).join('\n')
	};
}

export default class RollupResult extends CompileResult {
	summary: string;

	constructor(duration: number, compiler: RollupCompiler) {
		super();

		this.duration = duration;

		this.errors = compiler.errors.map(munge_warning_or_error);
		this.warnings = compiler.warnings.map(munge_warning_or_error); // TODO emit this as they happen

		this.chunks = compiler.chunks.map(chunk => ({
			file: chunk.fileName,
			imports: chunk.imports.filter(Boolean),
			modules: Object.keys(chunk.modules)
		}));

		this.css_files = compiler.css_files;

		// TODO populate this properly. We don't have named chunks, as in
		// webpack, but we can have a route -> [chunk] map or something
		this.assets = {};

		compiler.chunks.forEach(chunk => {
			if (compiler.input in chunk.modules) {
				this.assets.main = chunk.fileName;
			}
		});

		this.summary = compiler.chunks.map(chunk => {
			const size_color = chunk.code.length > 150000 ? colors.bold.red : chunk.code.length > 50000 ? colors.bold.yellow : colors.bold.white;
			const size_label = left_pad(pb(chunk.code.length), 10);

			const lines = [size_color(`${size_label} ${chunk.fileName}`)];

			const deps = Object.keys(chunk.modules)
				.map(file => {
					return {
						file: path.relative(process.cwd(), file),
						size: chunk.modules[file].renderedLength
					};
				})
				.filter(dep => dep.size > 0)
				.sort((a, b) => b.size - a.size);

			const total_unminified = deps.reduce((t, d) => t + d.size, 0);

			deps.forEach((dep, i) => {
				const c = i === deps.length - 1 ? '└' : '│';
				let line = `           ${c} ${dep.file}`;

				if (deps.length > 1) {
					const p = (100 * dep.size / total_unminified).toFixed(1);
					line += ` (${p}%)`;
				}

				lines.push(colors.gray(line));
			});

			return lines.join('\n');
		}).join('\n');
	}

	print() {
		const blocks: string[] = this.warnings.map(warning => {
			return warning.file
				? `> ${colors.bold(warning.file)}\n${warning.message}`
				: `> ${warning.message}`;
		});

		blocks.push(this.summary);

		return blocks.join('\n\n');
	}
}