// Keeps server.json's version in lockstep with package.json. Runs as the
// `version` npm lifecycle script, i.e. after `npm version` bumps
// package.json and before it makes the release commit — so one command
// versions both files and the release tag.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);
const path = new URL("../server.json", import.meta.url);
const server = JSON.parse(readFileSync(path, "utf-8"));
server.version = version;
writeFileSync(path, `${JSON.stringify(server, null, 2)}\n`);
