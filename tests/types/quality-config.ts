import { normalizeQualityConfig } from '../../runtime/quality.mjs';

interface QualityOptions {
  enabled: boolean;
}

const options: QualityOptions = { enabled: true };
normalizeQualityConfig(options);
