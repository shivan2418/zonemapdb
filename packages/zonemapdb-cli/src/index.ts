export { build, type BuildOptions, type BuildResult } from "./build.js";
export { resolveConfig, loadConfigFile } from "./config.js";
export { init, type InitOptions, type InitResult } from "./init.js";
export { inferSchema, type InferenceResult, type InferredField } from "./infer.js";
export { inspect, type InspectOptions, type InspectReport } from "./inspect.js";
export { runInteractiveInit, ensureInteractiveTTY, type InteractiveInitOptions } from "./wizard-tui.js";
export { getFormatVersion, getGeneratorVersion } from "./version.js";
export type {
  FieldConfig,
  FieldKind,
  InputFormat,
  Manifest,
  ResolvedConfig,
  SchemaDescriptor,
  BlockDescriptor,
  ZonemapDbConfig,
} from "./types.js";
