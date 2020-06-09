---
title: Prefetching
---

Sapper uses code splitting to break your app into small chunks (one per route), ensuring fast startup times.

For *dynamic* routes, such as our `src/routes/blog/[slug].svelte` example, that's not enough. In order to render the blog post, we need to fetch the data for it, and we can't do that until we know what `slug` is. In the worst case, that could cause lag as the browser waits for the data to come back from the server.


### rel=prefetch

We can mitigate that by *prefetching* the data. Adding a `rel=prefetch` attribute to a link...

```html
<a rel=prefetch href='blog/what-is-sapper'>What is Sapper?</a>
```

...will cause Sapper to run the page's `preload` function as soon as the user hovers over the link (on a desktop), touches (on mobile) or focuses it, rather than waiting for the `click` event to trigger navigation. Typically, this buys us an extra couple of hundred milliseconds, which is the difference between a user interface that feels laggy, and one that feels snappy.

> `rel=prefetch` is a Sapper idiom, not a standard attribute for `<a>` elements

<!-- TODO add a function to prefetch programmatically -->
