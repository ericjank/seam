#!/usr/bin/env node
import { readConfig } from "./config";
import { runConnector } from "./index";

try {
  await runConnector(readConfig(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
