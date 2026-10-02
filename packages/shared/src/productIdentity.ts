// Copyright 2026 1WorldCapture
// SPDX-License-Identifier: Apache-2.0

import type { ZCodeProductFlavor } from "./env.js";
import { ZCODE_PRODUCT_FLAVOR } from "./env.js";

/**
 * Single source of truth for user-facing product branding.
 *
 * Locale strings reference the product name through the `{appName}` placeholder,
 * which is resolved from here at render time so one set of locale files serves
 * every product flavor. Internal identifiers (`@zcode/*` packages, `ZCODE_*`
 * env vars) intentionally stay unchanged — only user-visible branding varies.
 */
export interface ProductIdentity {
  /** User-visible product name injected into UI copy via `{appName}`. */
  appName: string;
}

// "tinycode" is the external-release identity (task #28). The flavor literal is
// added to `ZCodeProductFlavor` by the flavor mechanism; the mapping is ready
// here so branding switches as soon as the union extends.
const IDENTITIES: Record<ZCodeProductFlavor | "tinycode", ProductIdentity> = {
  production: { appName: "ZCode" },
  preview: { appName: "ZCode" },
  tinycode: { appName: "TinyCode" },
};

const FALLBACK_IDENTITY: ProductIdentity = IDENTITIES.production;

export function resolveProductIdentity(flavor: string): ProductIdentity {
  return IDENTITIES[flavor as ZCodeProductFlavor | "tinycode"] ?? FALLBACK_IDENTITY;
}

export const PRODUCT_IDENTITY: ProductIdentity = resolveProductIdentity(ZCODE_PRODUCT_FLAVOR);
