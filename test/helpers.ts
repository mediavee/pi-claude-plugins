import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, "..");
export const FIXTURE_PLUGIN = resolve(here, "fixtures/demo-plugin");
export const FIXTURE_MARKETPLACE = resolve(here, "fixtures/demo-marketplace");
