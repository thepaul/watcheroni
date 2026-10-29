// Turns dist/ into the package that goes to npm: tsc has put index.js and
// index.d.ts there, and this adds README.md, LICENSE and a package.json
// whose `exports` point at the built files. The package.json next to src/
// points at the TypeScript source, which only works inside the workspace,
// and is private so it can't be published by mistake. Publish with
// `npm publish packages/protocol/dist` (see RELEASING.md).
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

const { private: _private, scripts: _scripts, devDependencies: _dev, exports: _exports, ...rest } = pkg;
const published = {
  ...rest,
  types: "./index.d.ts",
  exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  files: ["index.js", "index.d.ts"],
};

writeFileSync(new URL("package.json", dist), JSON.stringify(published, null, 2) + "\n");
for (const file of ["README.md", "LICENSE"]) copyFileSync(new URL(file, root), new URL(file, dist));
