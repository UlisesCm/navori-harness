import { legacyFormat } from "./text.js";

for (const item of process.argv.slice(2)) console.log(legacyFormat(item));
