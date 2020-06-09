import * as assert from 'assert';
import * as http from 'http';
import {build} from '../../../api';
import {AppRunner} from '../AppRunner';

declare let deleted: { id: number };
declare let el: any;

type Response = { headers: http.IncomingHttpHeaders, body: string };

function get(url: string, opts: http.RequestOptions = {}): Promise<Response> {
	return new Promise((fulfil, reject) => {
		const req = http.get(url, opts, res => {
			res.on('error', reject);

			let body = '';
			res.on('data', chunk => body += chunk);
			res.on('end', () => {
				fulfil({
					headers: res.headers,
					body
				});
			});
		});

		req.on('error', reject);
	});
}

describe('basics', function() {
	this.timeout(10000);

	let r: AppRunner;

	// hooks
	before('build app', () => build({ cwd: __dirname }));
	before('start runner', async () => {
		r = await new AppRunner().start(__dirname);
	});

	after(() => r && r.end());

	// tests
	it('serves /', async () => {
		await r.load('/');

		assert.equal(
			await r.text('h1'),
			'Great success!'
		);
	});

	it('serves /?', async () => {
		await r.load('/?');

		assert.equal(
			await r.text('h1'),
			'Great success!'
		);
	});

	it('serves static route', async () => {
		await r.load('/a');

		assert.equal(
			await r.text('h1'),
			'a'
		);
	});

	it('serves static route from dir/index.html file', async () => {
		await r.load('/b');

		assert.equal(
			await r.text('h1'),
			'b'
		);
	});

	it('serves dynamic route', async () => {
		await r.load('/test-slug');

		assert.equal(
			await r.text('h1'),
			'test-slug'
		);
	});

	it('navigates to a new page without reloading', async () => {
		await r.load('/');
		await r.sapper.start();
		await r.sapper.prefetchRoutes();

		const requests: string[] = await r.capture_requests(async () => {
			await r.page.click('a[href="a"]');
			await r.wait();
		});

		assert.deepEqual(requests, []);

		assert.equal(
			await r.text('h1'),
			'a'
		);
	});

	it('navigates programmatically', async () => {
		await r.load('/a');
		await r.sapper.start();
		await r.sapper.goto('b');

		assert.equal(
			await r.text('h1'),
			'b'
		);
	});

	it('prefetches programmatically', async () => {
		await r.load(`/a`);
		await r.sapper.start();

		const requests = await r.capture_requests(() => r.sapper.prefetch('b'));

		assert.equal(requests.length, 2);
		assert.equal(requests[1], `${r.base}/b.json`);
	});

	it('prefetches on focus', async () => {
		await r.load(`/prefetch`);
		await r.sapper.start();

		const requests = await r.capture_requests(() => r.page.focus('a'));

		assert.equal(requests.length, 2);
		assert.equal(requests[1], `${r.base}/b.json`);
	});

	// TODO equivalent test for a webpack app
	it('sets Content-Type, Link...modulepreload, and Cache-Control headers', async () => {
		const { headers } = await get(r.base);

		assert.equal(
			headers['content-type'],
			'text/html'
		);

		assert.equal(
			headers['cache-control'],
			'max-age=600'
		);

		// TODO preload more than just the entry point
		const regex = /<\/client\/client\.\w+\.js>;rel="modulepreload"/;
		const link = <string>headers['link'];

		assert.ok(regex.test(link), link);
	});

	it('calls a delete handler', async () => {
		await r.load('/delete-test');
		await r.sapper.start();

		await r.page.click('.del');
		await r.page.waitForFunction(() => deleted);

		assert.equal(await r.page.evaluate(() => deleted.id), 42);
	});

	it('hydrates initial route', async () => {
		await r.load('/');

		await r.page.evaluate(() => {
			el = document.querySelector('.hydrate-test');
		});

		await r.sapper.start();

		assert.ok(await r.page.evaluate(() => {
			return document.querySelector('.hydrate-test') === el;
		}));
	});

	it('does not attempt client-side navigation to server routes', async () => {
		await r.load('/');
		await r.sapper.start();
		await r.sapper.prefetchRoutes();

		await r.page.click('[href="ambiguous/ok.json"]');
		await r.wait();

		assert.equal(
			await r.text('body'),
			'ok'
		);
	});

	it('allows reserved words as route names', async () => {
		await r.load('/const');
		await r.sapper.start();

		assert.equal(
			await r.text('h1'),
			'reserved words are okay as routes'
		);
	});

	it('accepts value-less query string parameter on server', async () => {
		await r.load('/echo-query?message');

		assert.equal(
			await r.text('h1'),
			'{"message":""}'
		);
	});

	it('accepts value-less query string parameter on client', async () => {
		await r.load('/');
		await r.sapper.start();
		await r.sapper.prefetchRoutes();

		await r.page.click('a[href="echo-query?message"]');
		await r.wait();

		assert.equal(
			await r.text('h1'),
			'{"message":""}'
		);
	});

	it('accepts duplicated query string parameter on server', async () => {
		await r.load('/echo-query?p=one&p=two');

		assert.equal(
			await r.text('h1'),
			'{"p":["one","two"]}'
		);
	});

	it('accepts duplicated query string parameter on client', async () => {
		await r.load('/');
		await r.sapper.start();
		await r.sapper.prefetchRoutes();

		await r.page.click('a[href="echo-query?p=one&p=two"]')

		assert.equal(
			await r.text('h1'),
			'{"p":["one","two"]}'
		);
	});

	it('can access host through page store', async () => {
		await r.load('/host');

		assert.equal(await r.text('h1'), 'localhost');

		await r.sapper.start();
		assert.equal(await r.text('h1'), 'localhost');
	});

	// skipped because Nightmare doesn't seem to focus the <a> correctly
	it('resets the active element after navigation', async () => {
		await r.load('/');
		await r.sapper.start();
		await r.sapper.prefetchRoutes();

		await r.page.click('[href="a"]');
		await r.wait();

		assert.equal(
			await r.page.evaluate(() => document.activeElement.nodeName),
			'BODY'
		);
	});

	it('replaces %sapper.xxx% tags safely', async () => {
		await r.load('/unsafe-replacement');
		await r.sapper.start();

		const html = String(await r.page.evaluate(() => document.body.innerHTML));
		assert.equal(html.indexOf('%sapper'), -1);
	});

	it('navigates between routes with empty parts', async () => {
		await r.load('/dirs/foo');
		await r.sapper.start();

		assert.equal(await r.text('h1'), 'foo');
		await r.page.click('[href="dirs/bar"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'bar');
	});

	it('navigates to ...rest', async () => {
		await r.load('/abc/xyz');
		await r.sapper.start();

		assert.equal(await r.text('h1'), 'abc,xyz');
		await r.page.click('[href="xyz/abc/def/ghi"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'xyz,abc,def,ghi');
		assert.equal(await r.text('h2'), 'xyz,abc,def,ghi');
		await r.page.click('[href="xyz/abc/def"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'xyz,abc,def');
		assert.equal(await r.text('h2'), 'xyz,abc,def');
		await r.page.click('[href="xyz/abc/def"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'xyz,abc,def');
		assert.equal(await r.text('h2'), 'xyz,abc,def');
		await r.page.click('[href="xyz/abc"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'xyz,abc');
		assert.equal(await r.text('h2'), 'xyz,abc');
		await r.page.click('[href="xyz/abc/deep"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'xyz,abc');
		assert.equal(await r.text('h2'), 'xyz,abc');
		await r.page.click('[href="xyz/abc/qwe/deep.json"]');
		await r.wait();
		assert.equal(
			await r.text('body'),
			'xyz,abc,qwe'
		);
	});

	it('navigates between dynamic routes with same segments', async () => {
		await r.load('/dirs/bar/xyz');
		await r.sapper.start();

		assert.equal(await r.text('h1'), 'A page');

		await r.page.click('[href="dirs/foo/xyz"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'B page');
	});

	it('find regexp routes', async () => {
		await r.load('/qwe');
		await r.sapper.start();

		assert.equal(await r.text('h1'), 'qwe');

		await r.page.click('[href="234"]');
		await r.wait();

		assert.equal(await r.text('h1'), 'Regexp page 234');

		await r.page.click('[href="regexp/234"]');
		await r.wait();
		assert.equal(await r.text('h1'), 'Nested regexp page 234');
	});

	it('runs server route handlers before page handlers, if they match', async () => {
		const json = await get(`${r.base}/middleware`, {
			headers: {
				'Accept': 'application/json'
			}
		});

		assert.equal(json.body, '{"json":true}');

		const html = await get(`${r.base}/middleware`);

		assert.ok(html.body.indexOf('<h1>HTML</h1>') !== -1);
	});

	it('invalidates page when a segment is skipped', async () => {
		await r.load('/skipped/x/1');
		await r.sapper.start();
		await r.sapper.prefetchRoutes();

		await r.page.click('a[href="skipped/y/1"]');
		await r.wait();

		assert.equal(
			await r.text('h1'),
			'y:1'
		);
	});

	it('page store functions as expected', async () => {
		await r.load('/store');
		await r.sapper.start();

		assert.equal(await r.text('h1'), 'Test');
		assert.equal(await r.text('h2'), 'Called 1 time');

		await r.page.click('a[href="store/result"]');
		await r.wait();

		assert.equal(await r.text('h1'), 'Result');
		assert.equal(await r.text('h2'), 'Called 1 time');
	});

	it('survives the tests with no server errors', () => {
		assert.deepEqual(r.errors, []);
	});
});
