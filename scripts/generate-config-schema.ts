import { mkdirSync, writeFileSync } from "node:fs";
import {
  hearthConfigJsonSchema,
} from "../src/config-schema.js";

const outputPath = new URL("../schema/v1/hearth.schema.json", import.meta.url);

mkdirSync(new URL(".", outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(hearthConfigJsonSchema(), null, 2)}\n`);
