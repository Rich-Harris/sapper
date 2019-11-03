---
title: Testing
---

You can use whatever testing frameworks and libraries you'd like. The default in [sapper-template](https://github.com/sveltejs/sapper-template) is [Cypress](https://cypress.io).


### Running the tests

```bash
npm i -D cypress
npm test
```

The first command installs Cypress as a dev dependency. `npm test` starts the server and opens Cypress. You can (and should!) add your own tests in `cypress/integration/spec.js` — consult the [docs](https://docs.cypress.io/guides/overview/why-cypress.html) for more information.