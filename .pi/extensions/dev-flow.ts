// Dogfood wiring: this checkout must load its own working extension, not an installed copy.
// A pointer, not a copy — after any merge or pull, new sessions here run main's current code.
// A symlink would break: pi resolves a module's relative imports from the link's own directory.
export { default } from "../../extensions/dev-flow.ts";
