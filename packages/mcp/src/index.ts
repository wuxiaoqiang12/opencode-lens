#!/usr/bin/env node

import { createServer } from "./server";
import { runDoctor } from "./doctor";

export async function main() {
  const command = process.argv[2];
  if (command === "doctor") {
    await runDoctor({ json: process.argv.includes("--json") });
    return;
  }

  await createServer().run();
}

if (import.meta.main) {
  await main();
}
