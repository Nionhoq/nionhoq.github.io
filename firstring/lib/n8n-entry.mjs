// Bundled (esbuild → IIFE) into every FirstRing n8n Code node.
// n8n's Code sandbox replaces Object.defineProperty with a no-op, which silently empties
// esbuild's normal export object. So: no exports — assign a plain object to the `FR` the
// Code node declares just before this bundle.
import { makeCtx } from "./runtime.mjs";
import { handleVapi, handleTwilioSms, handleTwilioVoiceFallback, handleError, runHourly } from "./index.mjs";

// eslint-disable-next-line no-undef
FR = { makeCtx, handleVapi, handleTwilioSms, handleTwilioVoiceFallback, handleError, runHourly };
