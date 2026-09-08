import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hearthConfigJsonSchema,
  hearthConfigSchema,
} from "./config-schema.js";

assert.throws(
  () => hearthConfigSchema.parse({ configVersion: 1, typo: true }),
  /Unrecognized key/,
);

const generatedSchema = `${JSON.stringify(hearthConfigJsonSchema(), null, 2)}\n`;
const committedSchema = readFileSync(
  new URL("../schema/v1/hearth.schema.json", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
assert.equal(committedSchema, generatedSchema, "run `npm run schema:config` after changing config-schema.ts");

console.log("config schema tests passed");
