#!/usr/bin/env node
import { addCommand, packageSetup } from "./add-package.ts";

if (process.argv[2] !== "add") {
  console.error("Usage: extension-extender add [-l|--local] <git:|npm:>");
  process.exit(1);
}

const cwd = process.cwd();
const { agentDir, root, packages } = await packageSetup(cwd);
for (const message of await addCommand({ tokens: process.argv.slice(2), root, agentDir, cwd, packages })) {
  console.log(message.text);
}
