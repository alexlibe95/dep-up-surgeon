# Fixture origins

These `package.json` files are **minimal snapshots** inspired by public repositories (dependency names and approximate semver ranges). They are not verbatim copies; scripts and metadata are trimmed for faster `dep-up-surgeon --dry-run` tests.

| Fixture | Based on (GitHub) |
|---------|-------------------|
| `08-next-hello-world` | [vercel/next.js `examples/hello-world`](https://github.com/vercel/next.js/blob/canary/examples/hello-world/package.json) |
| `09-vite-vue-ts` | [vitejs/vite `packages/create-vite/template-vue-ts`](https://github.com/vitejs/vite/blob/main/packages/create-vite/template-vue-ts/package.json) |
| `10-astro-minimal` | [withastro/astro `examples/minimal`](https://github.com/withastro/astro/blob/main/examples/minimal/package.json) |
| `11-nest-sample-cats` | [nestjs/nest `sample/01-cats-app`](https://github.com/nestjs/nest/blob/master/sample/01-cats-app/package.json) (trimmed) |
| `12-express-style` | Subset of [expressjs/express](https://github.com/expressjs/express/blob/master/package.json) **dependencies** |

Existing fixtures `01`–`07` are synthetic.
