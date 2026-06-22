export type ProcessingRuntime = {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export const PROCESSING_RUNTIME = Symbol('PROCESSING_RUNTIME');

export const defaultProcessingRuntime: ProcessingRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};