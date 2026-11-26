import { Store } from './store.mjs';
import * as providers from './providers.mjs';
import { research } from './research.mjs';
import { deliver, releasePackage, prepareReleaseVersion, reconcileDelivery } from './delivery.mjs';
import { resolveTool, formatToolContext } from './tools.mjs';
import { runUIVerification, isCurrentUIReceipt } from './ui-verification.mjs';
import { runSecurityChecks, isCurrentSecurityReceipt } from './security-gates.mjs';
import { runArchitectureChecks, isCurrentArchitectureReceipt } from './architecture-gate.mjs';

export { Store, providers, research };
export const defaultDelivery = () => ({ deliver, releasePackage, prepareReleaseVersion, reconcileDelivery });
export const defaultGates = () => ({
  runUIVerification,
  isCurrentUIReceipt,
  runSecurityChecks,
  isCurrentSecurityReceipt,
  runArchitectureChecks,
  isCurrentArchitectureReceipt,
});
export const defaultTools = () => ({ resolveTool, formatToolContext });
