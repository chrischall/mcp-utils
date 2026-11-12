import { describe, expect, it } from 'vitest';
import * as convert from './index.js';

describe('@chrischall/mcp-utils/convert barrel', () => {
  it('exports the xlsx converter, CSV writer, zip reader and limits', () => {
    expect(typeof convert.convertXlsx).toBe('function');
    expect(typeof convert.toCsv).toBe('function');
    expect(typeof convert.openZip).toBe('function');
    expect(convert.DEFAULT_CONVERT_LIMITS.maxTextBytes).toBe(200 * 1024);
  });

  it('resolveConvertLimits fills defaults and ignores invalid values', () => {
    const l = convert.resolveConvertLimits({ maxImages: 3, maxPages: -1, maxTextBytes: Number.NaN });
    expect(l.maxImages).toBe(3);
    expect(l.maxPages).toBe(convert.DEFAULT_CONVERT_LIMITS.maxPages);
    expect(l.maxTextBytes).toBe(convert.DEFAULT_CONVERT_LIMITS.maxTextBytes);
    expect(l.maxUnzippedBytes).toBe(200 * 1024 * 1024);
  });
});
