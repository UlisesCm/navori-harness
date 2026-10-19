/// <reference path="../.astro/types.d.ts" />

declare module "*.astro" {
  const component: import("astro/runtime/server/index.js").AstroComponentFactory;
  export default component;
}
