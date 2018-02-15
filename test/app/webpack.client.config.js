const config = require('../../webpack/config.js');
const webpack = require('webpack');

module.exports = {
	entry: config.client.entry(),
	output: config.client.output(),
	resolve: {
		extensions: ['.js', '.html'],
		modules: ['routes', 'node_modules'],
	},
	module: {
		rules: [
			{
				test: /\.html$/,
				exclude: /node_modules/,
				use: {
					loader: 'svelte-loader',
					options: {
						hydratable: true,
						emitCss: !config.dev,
						cascade: false,
						store: true
					}
				}
			},
			{
				test: /\.css$/,
				use: [
					{ loader: "style-loader" },
					{ loader: "css-loader" }
				]
			}
		].filter(Boolean)
	},
	plugins: [
		config.dev && new webpack.HotModuleReplacementPlugin(),
		!config.dev && new webpack.optimize.ModuleConcatenationPlugin()
	].filter(Boolean),
	devtool: config.dev ? 'inline-source-map' : false
};