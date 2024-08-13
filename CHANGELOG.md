# v3 -> v4

- Added support for NodeJS 11+ workers
- `Caplink.proxy()` is now called `Caplink.wrap()`
- `Caplink.proxyValue()` is now called `Caplink.proxy()`
- Transferable values are _not_ transferred by default anymore. They need to be wrapped with `Caplink.transfer()`
- Rewrote TypeScript types
- New folder structure in the GitHub repo and in the npm module
