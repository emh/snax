import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

test("every app-shell resource exists locally", async () => {
  const source = await readFile(path.join(appDir, "sw.js"), "utf8");
  const appShell = source.match(/const APP_SHELL = \[(.*?)\];/s)?.[1];
  assert.ok(appShell, "APP_SHELL was not found");

  const urls = [...appShell.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(urls.length > 0, "APP_SHELL is empty");

  await Promise.all(
    urls.map(async (url) => {
      assert.ok(url.startsWith("./"), `APP_SHELL URL must be local: ${url}`);
      const relativePath = url === "./" ? "index.html" : url.slice(2);
      await access(path.join(appDir, relativePath));
    }),
  );
});
