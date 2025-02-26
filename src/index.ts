#!/usr/bin/env node
import { processAllIdls } from "./scan";
import { startServer } from "./server";

(async () => {
  await processAllIdls();
  startServer();
})();
