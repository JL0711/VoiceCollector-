#!/usr/bin/env node
// 打包收尾：删掉 electron-builder 摊开的中间产物（dist/mac、dist/mac-arm64 里的 .app）。
// 不删的话 Spotlight 会把它们当成「装好的 App」收录，她在启动台 / 搜索里会看到好几个 VoiceCollector。
// 这件事发生过两次（都是我打完包忘了清），所以放进打包命令里自动做，不再靠人记。
// dmg、zip、网页版、更新包都保留。
import { rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', 'dist');
let n = 0;
for (const name of readdirSync(DIST)) {
  if (/^mac(-arm64|-universal)?$/.test(name) || /\.blockmap$/.test(name) || name === 'builder-debug.yml') {
    rmSync(join(DIST, name), { recursive: true, force: true });
    n++;
  }
}
console.log(`✓ 清掉了 ${n} 个打包中间产物（dmg / zip 都在）`);
