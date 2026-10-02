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
  /**
   * Resolved flavor, so install-scoped identifiers that must not collide across
   * flavors (Finder workflow bundle id, Windows registry key) can branch on the
   * identity alone without reaching back into env internals.
   */
  flavor: ZCodeProductFlavor;
}

const IDENTITIES: Record<ZCodeProductFlavor, ProductIdentity> = {
  production: { appName: "ZCode", flavor: "production" },
  preview: { appName: "ZCode", flavor: "preview" },
  tinycode: { appName: "TinyCode", flavor: "tinycode" },
};

const FALLBACK_IDENTITY: ProductIdentity = IDENTITIES.production;

export function resolveProductIdentity(flavor: string): ProductIdentity {
  return IDENTITIES[flavor as ZCodeProductFlavor | "tinycode"] ?? FALLBACK_IDENTITY;
}

export const PRODUCT_IDENTITY: ProductIdentity = resolveProductIdentity(ZCODE_PRODUCT_FLAVOR);
