const SNAX_HOST = globalThis.location?.hostname || "";
const SNAX_IS_LOCAL = SNAX_HOST === "localhost" ||
  SNAX_HOST === "127.0.0.1" ||
  SNAX_HOST.endsWith(".local") ||
  /^10\./.test(SNAX_HOST) ||
  /^192\.168\./.test(SNAX_HOST) ||
  /^169\.254\./.test(SNAX_HOST) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(SNAX_HOST);

globalThis.SNAX_CONFIG = globalThis.SNAX_CONFIG || {
  syncBaseUrl: SNAX_IS_LOCAL ? "" : "https://snax-sync.emh.workers.dev"
};
