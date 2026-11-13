import { addCommand, packageSetup } from "./add-package.ts";

const cwd = process.cwd();
const { agentDir, root, packages } = await packageSetup(cwd);
for (const message of await addCommand({ tokens: process.argv.slice(2), root, agentDir, cwd, packages })) {
  console.log(message.text);
}
