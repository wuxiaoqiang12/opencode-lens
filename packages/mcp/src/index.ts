#!/usr/bin/env node

import { createServer } from "./server";

export async function main() {
  await createServer().run();
}

if (import.meta.main) {
  await main();
}
