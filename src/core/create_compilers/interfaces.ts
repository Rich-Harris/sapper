import { ManifestData, Dirs } from '../../interfaces';

export type Chunk = {
	file: string;
	imports: string[];
	modules: string[];
}

export type CssFile = {
	id: string;
	code: string;
};

export class CompileError {
	file: string;
	message: string;
}

export interface CompileResult {
	duration: number;
	errors: CompileError[];
	warnings: CompileError[];
	chunks: Chunk[];
	assets: Record<string, string>;
	css_files: CssFile[];

	to_json: (manifest_data: ManifestData, dirs: Dirs) => BuildInfo
}

export type CssBuildInfo = {
	main: string | null,
	chunks: Record<string, string[]>
}

export type BuildInfo = {
	bundler: string;
	shimport: string;
	assets: Record<string, string>;
	legacy_assets?: Record<string, string>;
	css: CssBuildInfo
}