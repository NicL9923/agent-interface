import { z } from "zod";
// zod's eval support probe is caught, but a strict CSP still reports it as a violation.
z.config({ jitless: true });
