/**
 * 不可信 XML 的入场门禁：DOCTYPE / ENTITY 一律拒绝（XXE 防线）。
 */

import { RoadNetError } from './types.js'

/** 文本含 DOCTYPE / ENTITY 声明时抛 `INVALID_XML`。 */
export function assertXmlSafe(text: string, name: string): void {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) {
    throw new RoadNetError({
      code: 'INVALID_XML',
      message: `${name} contains DOCTYPE/ENTITY declarations and was rejected to prevent entity injection.`,
    })
  }
}
